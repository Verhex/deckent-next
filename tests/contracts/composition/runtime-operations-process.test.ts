import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { conditionalRecordServer } from '../support/conditional-record-server.js';

// C12 G4 acceptance on the shipped processes: compiled `runtime serve` + compiled MCP stdio. execute_operation (loopback HTTP target)
// answers approval-pending without an effect; decide_approval decides it over the MCP process's live runtime connection; the same
// command settles once; the ledger holds exactly one intent (settled) and one approval record.
type Child = ChildProcess & { stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']> };
const children = new Set<Child>(), cleanup: (() => Promise<void>)[] = [];
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const execFileAsync = promisify(execFile);
const mcp = resolve('dist/composition/core/mcp/internal/entry.js');
afterEach(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  await Promise.all([...children].map(child => child.exitCode !== null ? undefined : new Promise(done => child.once('close', done))));
  children.clear(); clearConfigCache();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function ready(child: Child): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      for (const line of buffer.split('\n')) { try { if ((JSON.parse(line) as { event?: string }).event === 'ready') resolveReady(); } catch { /* partial line */ } }
    });
    child.once('close', code => reject(new Error(`SERVICE_CLOSED_${code}`)));
  });
}
const ref = (id: string) => ({ id, version: 1 });
const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];

it.skipIf(process.platform !== 'linux')('compiled MCP execute_operation: pending, decided over the live runtime connection, the same command settles once (C12 G4)', async () => {
  const records = await conditionalRecordServer(); cleanup.push(records.close);
  const root = await mkdtemp(join(tmpdir(), 'deckent-runtime-ops-process-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent', 'config.json'), JSON.stringify({ layout: { root: join(root, 'data') },
    runRuntime: { pollIntervalMs: 2147483647 },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 4, maxConcurrentExecutions: 1,
      headerTimeoutMs: 1000, responseTimeoutMs: 5000, shutdownGraceMs: 1000 },
    operations: { catalog: [{ schemaVersion: 1, operation: ref('post-order'), targetKind: 'records', effectClass: 'write', approval: 'policy',
      precondition: 'record-version', compensation: null, inputMaxBytes: 4096 }],
    targets: [{ adapter: 'http-conditional', options: { kind: 'records', baseUrl: records.baseUrl, timeoutMs: 2000, responseMaxBytes: 65536, idempotencyLookup: true } }] },
  }), { mode: 0o600 });
  const env = { ...process.env, HOME: join(root, 'home') };
  registerProviderConfig(); // as every composed entry does before loading configuration
  const opened = await openConfiguredAttemptStore(project, { env });
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'ops-process', restrictions: [], grants: [
    { id: 'operations', effect: 'allow', actions: ['execute', 'inspect'], scopes: ['s'], principals, resource: { kind: 'operation', ids: 'all' } },
    { id: 'approvals', effect: 'allow', actions: 'all', scopes: ['s'], principals, resource: { kind: 'approval', ids: 'all' } },
    { id: 'gate', effect: 'require-approval', actions: ['execute'], scopes: ['s'], principals, resource: { kind: 'operation', ids: ['post-order'] } }] }), { mode: 0o600 });
  const ledger = opened.path; opened.store.close(); clearConfigCache(); records.records.set('PO-1', 1);

  const service = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] }) as Child;
  children.add(service); let serviceError = ''; service.stderr.on('data', chunk => { serviceError += String(chunk); });
  await bounded(ready(service), 'SERVICE_READY_TIMEOUT');
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', project], cwd: project, env, stderr: 'pipe' });
  const client = new Client({ name: 'runtime-operations-process', version: '1' });
  try {
    await bounded(client.connect(transport), 'MCP_CONNECT_TIMEOUT');
    const tools = (await bounded(client.listTools(), 'MCP_LIST_TIMEOUT')).tools;
    // Hints come from this installation's catalog (one write operation), not from a fixed table.
    expect(tools.find(tool => tool.name === 'execute_operation')?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    expect(tools.find(tool => tool.name === 'inspect_operation')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const command = { schemaVersion: 1, commandId: 'mcp-gated', scopeId: 's', operation: ref('post-order'), target: { kind: 'records', id: 'PO-1' },
      idempotencyKey: 'mcp-key', input: { amount: 10 }, expectedVersion: '"v1"' };
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await bounded(client.callTool({ name, arguments: args }), `MCP_${name}_TIMEOUT`);
      if (result.isError) throw new Error(`${name}:${JSON.stringify(result.content)}:${serviceError}`);
      // A list result travels as text only (structuredContent is an object by protocol).
      return (result.structuredContent ?? JSON.parse((result.content as { text: string }[])[0]!.text)) as Record<string, unknown> & { approval?: { approvalId: string } };
    };
    const pending = await call('execute_operation', command);
    expect(pending).toMatchObject({ schemaVersion: 2, status: 'approval-pending', commandId: 'mcp-gated', approval: { revision: 0 } });
    expect(records.operations).toHaveLength(0);
    const listed = await call('list_approvals', { schemaVersion: 1, scopeId: 's', afterId: null, limit: 10 });
    expect(listed).toEqual([expect.objectContaining({ status: 'pending', request: expect.objectContaining({ approvalId: pending.approval!.approvalId,
      subject: expect.objectContaining({ kind: 'operation', commandId: 'mcp-gated' }) }) })]);
    // B1 (owner 2026-10-01): MCP never allows; the request stays pending. The owner allows it from the CLI (peer-session; an operation
    // approval needs no turn capability) over the same live runtime service.
    const decision = { schemaVersion: 1, scopeId: 's', approvalId: pending.approval!.approvalId, commandId: 'cli-allow', expectedRevision: 0, decision: 'allow', reason: 'Reviewed' };
    await expect(call('decide_approval', { ...decision, commandId: 'mcp-allow' })).rejects.toThrow(/APPROVAL_ATTENDED_REQUIRED/u);
    const commandPath = join(root, 'decision.json'); await writeFile(commandPath, JSON.stringify(decision));
    const decided = JSON.parse((await bounded(execFileAsync(process.execPath, [cli, 'approval', 'decide', '--input', commandPath, '--json'], { cwd: project, env }), 'CLI_DECIDE_TIMEOUT')).stdout);
    expect(decided).toMatchObject({ status: 'decided', decision: { decision: 'allow', channel: 'local-cli', assurance: 'peer-session' } });
    const settled = await call('execute_operation', command);
    expect(settled).toMatchObject({ schemaVersion: 1, status: 'settled', commandId: 'mcp-gated', sequence: 1, version: '"v2"' });
    expect(await call('execute_operation', command)).toEqual(settled);
    expect(records.operations).toHaveLength(1);
    expect(await call('inspect_operation', { schemaVersion: 1, scopeId: 's', commandId: 'mcp-gated' })).toMatchObject({ record: { state: 'settled',
      intent: { approval: { approvalId: pending.approval!.approvalId } } } });
    // A scope without a trusted grant is a typed tool error before any ledger access; nothing is sent.
    const refused = await bounded(client.callTool({ name: 'execute_operation', arguments: { ...command, commandId: 'x', scopeId: 'elsewhere' } }), 'MCP_REFUSED_TIMEOUT');
    expect(refused.isError).toBe(true); expect(JSON.parse((refused.content as { text: string }[])[0]!.text)).toEqual({ schemaVersion: 1, code: 'POLICY_DENIED' });
    expect(records.operations).toHaveLength(1);
    const db = new DatabaseSync(ledger, { readOnly: true });
    try {
      expect(db.prepare('SELECT command_id,state,sequence FROM effect_intents').all()).toEqual([{ command_id: 'mcp-gated', state: 'settled', sequence: 1 }]);
      expect(db.prepare('SELECT approval_id FROM approvals').all()).toEqual([{ approval_id: pending.approval!.approvalId }]);
    } finally { db.close(); }
  } finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); }
});
