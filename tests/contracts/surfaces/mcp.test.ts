import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo, hostname } from 'node:os';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/index.js';
import { getPolicyVocabulary, inspectRun, requestRunCancellation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { startTestRuntimeService, stopTestRuntimeService } from '../support/runtime-service.js';
it('advertises real schemas and bounds concurrent calls, response size and error disclosure', async () => {
  let release!: () => void; let entered!: () => void; const waiting = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  const server = createMcpServer({ async inspectRun() { entered(); await gate; return { oversized: 'x'.repeat(1000) }; }, async inspectInventory() { throw new Error('/private secret'); } }, { maxConcurrentCalls: 1, responseMaxBytes: 100 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); const client = new Client({ name: 'test', version: '1' }); await client.connect(ct);
  try {
    const tools = await client.listTools(); expect(tools.tools.map(t => t.name)).toEqual(['inspect_run', 'inspect_inventory', 'policy_vocabulary']);
    expect(tools.tools[0]!.inputSchema.required).toContain('scopeId');
    const first = client.callTool({ name: 'inspect_run', arguments: { schemaVersion: 1, scopeId: 's', runId: 'r' } }); await waiting;
    expect(JSON.stringify(await client.callTool({ name: 'policy_vocabulary', arguments: {} }))).toContain('MCP_BUSY'); release();
    expect(JSON.stringify(await first)).toContain('MCP_RESPONSE_LIMIT');
    const failed = JSON.stringify(await client.callTool({ name: 'inspect_inventory', arguments: { schemaVersion: 1, scopeId: 's' } }));
    expect(failed).toContain('MCP_TOOL_FAILED'); expect(failed).not.toContain('secret');
    expect(JSON.stringify(await client.callTool({ name: 'inspect_run', arguments: { schemaVersion: 1, scopeId: 's', runId: 'r', principal: 'admin' } }))).toContain('MCP_INPUT_INVALID');
  } finally { release(); await client.close(); await server.close(); }
});
it.skipIf(process.platform === 'win32')('serves explicit-project inspection and cancellation intent with SDK parity and fresh policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mcp-')); const project = join(root, 'project'); const data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }));
  const env = { HOME: join(root, 'home') }; const { store } = await openConfiguredAttemptStore(project, { env });
  try { await admitRunAttempts(store, [{ runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 }]); } finally { store.close(); }
  const writePolicy = async (allow: boolean, cancel = false) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: allow ? [
    { id: 'read', effect: 'allow', actions: ['inspect', ...(cancel ? ['cancel'] : [])], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'run', ids: ['r'] } },
  ] : [] }), { mode: 0o600 });
  await writePolicy(true);
  const runtime = await startTestRuntimeService(project, env);
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/composition/core/mcp/internal/entry.js'), '--project', project], cwd: root, env, stderr: 'pipe' });
  const client = new Client({ name: 'deckent-proof', version: '1' });
  try {
    await client.connect(transport); const query = { schemaVersion: 1 as const, scopeId: 's', runId: 'r' };
    const result = await client.callTool({ name: 'inspect_run', arguments: query }); expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(await inspectRun(project, query, { env }));
    expect((await client.callTool({ name: 'policy_vocabulary', arguments: {} })).structuredContent).toEqual(getPolicyVocabulary());
    const command = { ...query, commandId: 'cancel', action: 'cancel' as const, expectedRevision: 1 };
    expect(JSON.stringify(await client.callTool({ name: 'request_run_cancellation', arguments: command }))).toContain('POLICY_DENIED');
    expect((await inspectRun(project, query, { env })).run!.cancellationRequested).toBe(false);
    await writePolicy(true, true);
    expect(JSON.stringify(await client.callTool({ name: 'request_run_cancellation', arguments: { ...command, principal: 'admin' } }))).toContain('MCP_INPUT_INVALID');
    const cancellation = await client.callTool({ name: 'request_run_cancellation', arguments: command });
    expect(cancellation.isError).not.toBe(true); expect(cancellation.structuredContent).toEqual(await requestRunCancellation(project, command, { env }));
    const recorded = (await inspectRun(project, query, { env })).run!;
    expect(recorded.cancellationRequested).toBe(true); expect(recorded.tasks[0]!.phase).toBe('cancelled');
    await writePolicy(true, false);
    expect(JSON.stringify(await client.callTool({ name: 'request_run_cancellation', arguments: command }))).toContain('POLICY_DENIED');
    await writePolicy(false);
    expect(JSON.stringify(await client.callTool({ name: 'request_run_cancellation', arguments: command }))).toContain('POLICY_DENIED');
    expect(JSON.stringify(await client.callTool({ name: 'inspect_run', arguments: query }))).toContain('POLICY_DENIED');
    const tools = (await client.listTools()).tools;
    expect(tools.filter(t => !['decide_approval', 'renew_approval', 'create_run', 'reserve_run_tasks', 'request_run_cancellation', 'deliver_run_cancellation', 'reconcile_attempt', 'execute_task', 'evaluate_task', 'shutdown_runtime_service', 'admit_model_activation', 'invoke_model', 'purge_model_invocation_content', 'cancel_model_invocation', 'audit_provider_spending'].includes(t.name)).every(t => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.find(t => t.name === 'cancel_model_invocation')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect(tools.find(t => t.name === 'purge_model_invocation_content')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect(tools.find(t => t.name === 'invoke_model')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    expect(tools.find(t => t.name === 'inspect_model_invocation')!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tools.find(t => t.name === 'admit_model_activation')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect(tools.find(t => t.name === 'admit_model_activation')!.inputSchema.type).toBe('object');
    expect(tools.find(t => t.name === 'inspect_model_activation')!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find(t => t.name === 'runtime_service_descriptor')!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find(t => t.name === 'shutdown_runtime_service')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find(t => t.name === 'request_run_cancellation')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(tools.find(t => t.name === 'audit_provider_spending')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  } finally { await client.close(); await transport.close(); await stopTestRuntimeService(runtime); await rm(root, { recursive: true, force: true }); }
}, 15000);

it('rejects oversized unterminated stdio input with a sanitized transport error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mcp-input-'));
  await mkdir(join(root, '.deckent'), { mode: 0o700 });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ mcp: { inputMaxBytes: 256 } }));
  const child = spawn(process.execPath, [resolve('dist/composition/core/mcp/internal/entry.js')], {
    cwd: root, env: { ...process.env, HOME: join(root, 'home') }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = ''; let timedOut = false;
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdin.on('error', () => {});
  const closed = once(child, 'close');
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
  try {
    child.stdin.end('{"private":"' + 'secret'.repeat(100));
    await closed;
    expect(timedOut).toBe(false);
    expect(stdout).toBe('');
    expect(stderr).toBe('MCP_TRANSPORT_FAILED\n');
  } finally { clearTimeout(timer); child.kill(); await rm(root, { recursive: true, force: true }); }
}, 10000);

it.each([['--project', ''], ['--unknown', 'private'], ['unexpected']])('rejects invalid MCP launch arguments %j without protocol output', async (...args) => {
  const child = spawn(process.execPath, [resolve('dist/composition/core/mcp/internal/entry.js'), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const closed = once(child, 'close'); child.stdin.end();
  const [code] = await closed;
  expect(code).toBe(1); expect(stdout).toBe(''); expect(stderr).toBe('MCP_START_FAILED\n');
});
