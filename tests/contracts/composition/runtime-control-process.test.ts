import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';

type Child = ChildProcess & { stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']> };
const children = new Set<Child>(), roots: string[] = [];
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const mcp = resolve('dist/composition/core/mcp/internal/entry.js');

afterEach(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  await Promise.all([...children].map(child => closed(child).then(() => undefined, () => undefined)));
  children.clear(); clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function start(module: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Child {
  const child = spawn(process.execPath, [module, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }) as Child;
  children.add(child); return child;
}
function closed(child: Child): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
}
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), milliseconds);
  })]); } finally { if (timer) clearTimeout(timer); }
}
function waitForJson(child: Child, predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolveValue, reject) => {
    let buffer = '';
    const data = (chunk: Buffer) => {
      buffer += String(chunk); const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (predicate(value)) { child.stdout.off('data', data); resolveValue(value); return; }
      } catch { /* Process failure is reported with bounded exit evidence below. */ }
    };
    child.stdout.on('data', data); child.once('error', reject);
    child.once('close', code => reject(new Error(`PROCESS_CLOSED_${code}`)));
  });
}
async function runJson(args: readonly string[], fixture: Awaited<ReturnType<typeof projectFixture>>) {
  const child = start(cli, args, fixture.project, fixture.env); child.stdin.end();
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  const code = await bounded(closed(child), 'CLI_TIMEOUT');
  if (code !== 0) throw new Error(`CLI_EXIT_${code}:${stderr.trim()}`);
  return { child, value: JSON.parse(stdout.trim()) as Record<string, unknown> };
}

async function projectFixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-runtime-control-process-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent', 'config.json'), JSON.stringify({ layout: { root: data },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: ['service-scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { identity: { scopeId: 'service-scope', serviceId: 'runtime' }, inputMaxBytes: 65536, responseMaxBytes: 65536,
      maxConnections: 8, maxConcurrentRequests: 4, maxConcurrentExecutions: 1, headerTimeoutMs: 1000,
      responseTimeoutMs: 1000, shutdownGraceMs: 1000 },
  }), { mode: 0o600 });
  const env = { ...process.env, HOME: home };
  const opened = await openConfiguredAttemptStore(project, { env });
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'process-policy', restrictions: [], grants: [{
    id: 'shutdown', effect: 'allow', actions: ['shutdown'], scopes: ['service-scope'], principals,
    resource: { kind: 'service', ids: ['runtime'] },
  }] }), { mode: 0o600 });
  const ledgerPath = opened.path; opened.store.close(); clearConfigCache();
  return { project, env, ledgerPath };
}

function durableReceipt(path: string, commandId: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const admission = db.prepare('SELECT record FROM service_shutdown_commands WHERE command_id=?').get(commandId) as { record: string };
    const outcome = db.prepare('SELECT record FROM service_shutdown_outcomes WHERE command_id=?').get(commandId) as { record: string };
    return { admission: JSON.parse(admission.record) as Record<string, unknown>, outcome: JSON.parse(outcome.record) as Record<string, unknown> };
  } finally { db.close(); }
}

it.skipIf(process.platform !== 'linux')('compiled CLI describes then admits exact-instance shutdown with actual peer PID and durable clean outcome', async () => {
  const fixture = await projectFixture(); const service = start(cli, ['runtime', 'serve', '--json'], fixture.project, fixture.env);
  let serviceError = ''; service.stderr.on('data', chunk => { serviceError += String(chunk); });
  await bounded(waitForJson(service, value => value.event === 'ready'), 'SERVICE_READY_TIMEOUT');
  const described = await runJson(['runtime', 'describe', '--json'], fixture);
  expect(described.value).toMatchObject({ shutdownAvailable: true, identity: { scopeId: 'service-scope', serviceId: 'runtime' } });
  const instanceId = String(described.value.instanceId), commandId = 'cli-shutdown';
  const shutdown = start(cli, ['runtime', 'shutdown', '--service', 'runtime', '--instance', instanceId,
    '--command-id', commandId, '--reason', 'compiled CLI acceptance', '--json'], fixture.project, fixture.env);
  const shutdownPid = shutdown.pid; shutdown.stdin.end(); let output = ''; shutdown.stdout.on('data', chunk => { output += String(chunk); });
  expect(await bounded(closed(shutdown), 'SHUTDOWN_CLI_TIMEOUT')).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ replayed: false, admission: { command: { commandId, instanceId } } });
  expect(await bounded(closed(service), `SERVICE_STOP_TIMEOUT:${serviceError}`)).toBe(0);
  const receipt = durableReceipt(fixture.ledgerPath, commandId);
  expect(receipt.admission).toMatchObject({ command: { commandId, instanceId }, actor: { evidence: { pid: shutdownPid, uid: userInfo().uid } } });
  expect(receipt.outcome).toMatchObject({ commandId, instanceId, state: 'clean', remainingRequests: 0, recoveryPending: false });
});

it.skipIf(process.platform !== 'linux')('compiled MCP descriptor and shutdown tools share the daemon protocol and retain a clean outcome', async () => {
  const fixture = await projectFixture(); const service = start(cli, ['runtime', 'serve', '--json'], fixture.project, fixture.env);
  await bounded(waitForJson(service, value => value.event === 'ready'), 'SERVICE_READY_TIMEOUT');
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', fixture.project],
    cwd: fixture.project, env: fixture.env, stderr: 'pipe' });
  const client = new Client({ name: 'runtime-control-process', version: '1' });
  try {
    await bounded(client.connect(transport), 'MCP_CONNECT_TIMEOUT');
    const described = await bounded(client.callTool({ name: 'runtime_service_descriptor', arguments: {} }), 'MCP_DESCRIPTOR_TIMEOUT');
    expect(described.isError).not.toBe(true);
    const descriptor = described.structuredContent as { instanceId: string; identity: { serviceId: string } };
    const command = { schemaVersion: 1, commandId: 'mcp-shutdown', serviceId: descriptor.identity.serviceId,
      instanceId: descriptor.instanceId, reason: 'compiled MCP acceptance' };
    const admitted = await bounded(client.callTool({ name: 'shutdown_runtime_service', arguments: command }), 'MCP_SHUTDOWN_TIMEOUT');
    expect(admitted.isError).not.toBe(true); expect(admitted.structuredContent).toMatchObject({ replayed: false, admission: { command } });
    expect(await bounded(closed(service), 'MCP_SERVICE_STOP_TIMEOUT')).toBe(0);
    const receipt = durableReceipt(fixture.ledgerPath, command.commandId);
    expect(receipt.admission).toMatchObject({ command });
    expect(receipt.outcome).toMatchObject({ commandId: command.commandId, instanceId: command.instanceId,
      state: 'clean', remainingRequests: 0, recoveryPending: false });
  } finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); }
});
