import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createConfiguredRuntimeClient, requestRunCancellation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import { identifyDockerRequest } from '#adapters/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const exec = promisify(execFile);
type Child = ChildProcess & { stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']> };
function childClosed(child: Child): Promise<number | null> {
  return new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
}
async function bounded<T>(promise: Promise<T>, child: Child, label: string, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(label)); }, milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function startCli(cli: string, project: string, env: NodeJS.ProcessEnv, args: string[]): Child {
  return spawn(process.execPath, [cli, ...args], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] }) as Child;
}
function waitForJson(child: Child, predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolveValue, reject) => {
    let buffer = '';
    const data = (chunk: Buffer) => {
      buffer += String(chunk);
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { const value = JSON.parse(line) as Record<string, unknown>; if (predicate(value)) { child.stdout.off('data', data); resolveValue(value); } }
        catch { /* A fatal assertion below retains stderr and exit evidence. */ }
      }
    };
    child.stdout.on('data', data);
    child.once('error', reject);
  });
}
async function poll<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const value = await read(); if (value !== undefined) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error(label);
}

it.skipIf(!imageId || process.platform !== 'linux')('keeps execution across client death and service grace exit, then recovers durable cancellation after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dk-svc-p-'));
  const project = join(root, 'p'), data = join(root, 'd'), configPath = join(project, '.deckent/config.json');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', project, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'input'), 'base\n'); await git('add', 'input'); await git('commit', '-m', 'base');
  const readyName = `ready-${randomUUID()}`; const registry = fixtureDockerRegistry(['service-process']);
  registry.profiles[0]!.parameters = { ...registry.profiles[0]!.parameters, imageId,
    argv: ['node', '-e', `require('node:fs').writeFileSync('/workspace/${readyName}','yes');setInterval(()=>{},1000)`] };
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000,
    outputBytes: 65536 };
  const baseConfig = { layout: { root: data }, artifacts: { maxBytes: 65536 }, admission: { poolId: 'p', executionSlots: 1,
    inFlightSlots: 1, ordering: 'input-order', registry }, cancellation: { maxConcurrentDeliveries: 1, maxAttempts: 3,
    retryDelayMs: 10, claimTtlMs: 100, recoveryPageSize: 2 }, cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 50,
    failureBackoffMs: 50 }, service: { inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 4,
    maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 50 }, execution: { docker,
    git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } };
  await writeFile(configPath, JSON.stringify(baseConfig));
  const env = { ...process.env, HOME: join(root, 'h') }; const options = { env };
  const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  const ledgerPath = opened.path; opened.store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'cancel', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'cancel'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  const cli = resolve('dist/composition/core/cli/internal/entry.js');
  let service: Child | undefined; let execution: Child | undefined; let handle: string | undefined; let endpoint: string | undefined;
  try {
    service = startCli(cli, project, env, ['runtime', 'serve', '--json']);
    let serviceErr = ''; service.stderr.on('data', chunk => { serviceErr += String(chunk); });
    await bounded(waitForJson(service, value => value.event === 'ready'), service, 'SERVICE_READY_TIMEOUT');
    const client = createConfiguredRuntimeClient(project, options);
    const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'service-process', dependencies: [], acceptanceCriteria: ['exit'] }],
      criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
    await client.createRun({ schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph });
    const identity = (await client.reserveRunTasks({ schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r', expectedRevision: 0 })).reservation.identities[0]!;
    const identityArgs = ['--scope', identity.scopeId, '--run', identity.runId, '--task', identity.taskId, '--attempt', identity.attemptId,
      '--generation', String(identity.generation), '--layout-revision', identity.layoutRevision, '--json'];
    execution = startCli(cli, project, env, ['task', 'execute', ...identityArgs]); const executionClosed = childClosed(execution);
    const record = await poll(async () => {
      const current = await openConfiguredAttemptStore(project, options);
      try {
        const value = await current.store.loadBoundDispatch(identity);
        if (value?.launch !== 'granted') return undefined;
        try { return await readFile(join(value.request.workspace, readyName), 'utf8') === 'yes' ? value : undefined; }
        catch { return undefined; }
      } finally { current.store.close(); }
    }, 'WORKER_READY_TIMEOUT');
    endpoint = (record.profile.parameters as { endpoint: string }).endpoint;
    handle = identifyDockerRequest(record.request, { ...docker, workspaceRoot: resolve(data, 'workspaces'),
      uid: userInfo().uid, gid: userInfo().gid }).handle;
    await expect(client.executeTask(identity)).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_BUSY' });
    expect((await client.inspectRun({ schemaVersion: 1, scopeId: 's', runId: 'r' })).run?.runId).toBe('r');
    execution.kill('SIGKILL'); await bounded(executionClosed, execution, 'CLIENT_EXIT_TIMEOUT');
    expect((await exec('/usr/bin/docker', ['--host', endpoint, 'inspect', '--format', '{{.State.Running}}', handle])).stdout.trim()).toBe('true');
    const firstClosed = childClosed(service); service.kill('SIGTERM');
    expect(await bounded(firstClosed, service, 'SERVICE_INCOMPLETE_EXIT_TIMEOUT')).not.toBe(0);
    expect(serviceErr).toContain('RUNTIME_SERVICE_SHUTDOWN_INCOMPLETE');
    expect((await exec('/usr/bin/docker', ['--host', endpoint, 'inspect', '--format', '{{.State.Running}}', handle])).stdout.trim()).toBe('true');

    await requestRunCancellation(project, { schemaVersion: 1, commandId: 'cancel', action: 'cancel', scopeId: 's', runId: 'r', expectedRevision: 1 }, options);
    const changed = structuredClone(baseConfig) as Record<string, unknown>; delete changed.execution;
    await writeFile(configPath, JSON.stringify(changed)); clearConfigCache();
    service = startCli(cli, project, env, ['runtime', 'serve', '--json']);
    await bounded(waitForJson(service, value => value.event === 'ready'), service, 'RESTART_READY_TIMEOUT');
    await poll(async () => {
      const value = (await exec('/usr/bin/docker', ['--host', endpoint!, 'inspect', '--format', '{{.State.Running}}', handle!])).stdout.trim();
      return value === 'false' ? value : undefined;
    }, 'AUTONOMOUS_CANCELLATION_TIMEOUT');
    await poll(async () => {
      const proof = await openConfiguredAttemptStore(project, options);
      try {
        const attempt = await proof.store.load('s', identity.attemptId);
        return attempt?.lastObservation ? attempt : undefined;
      } finally { proof.store.close(); }
    }, 'CANCELLATION_PERSISTENCE_TIMEOUT').then(attempt => {
      expect(attempt).toMatchObject({ cancelRequested: true, lastObservation: { result: { kind: 'exited' } } });
    });
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try { expect(JSON.parse(String((db.prepare('SELECT record FROM cancellation_deliveries WHERE scope_id=? AND attempt_id=?')
      .get('s', identity.attemptId) as { record: string }).record))).toMatchObject({ identity, state: 'terminal' }); }
    finally { db.close(); }
    const restartedClosed = childClosed(service); service.kill('SIGTERM');
    expect(await bounded(restartedClosed, service, 'SERVICE_CLEAN_EXIT_TIMEOUT')).toBe(0);
  } finally {
    for (const child of [execution, service]) if (child && child.exitCode === null && child.signalCode === null) {
      const closing = childClosed(child); child.kill('SIGKILL'); await closing.catch(() => null);
    }
    if (handle && endpoint) await exec('/usr/bin/docker', ['--host', endpoint, 'rm', '-f', handle]).catch(() => undefined);
    clearConfigCache(); await rm(root, { recursive: true, force: true });
  }
}, 40_000);
