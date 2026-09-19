import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createRun, inspectRun, reserveRunTasks } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { FileArtifactStore, identifyDockerRequest } from '#adapters/index.js';
import { parseRetainedOutputEnvelope } from '#engine/index.js';
import { clearConfigCache } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const exec = promisify(execFile);
type Child = ChildProcess & { stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']> };

function closed(child: Child): Promise<number | null> {
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
async function poll<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 750; attempt++) {
    const value = await read(); if (value !== undefined) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error(label);
}
function waitForJson(child: Child, predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolveValue, reject) => {
    let buffer = '';
    const data = (chunk: Buffer) => {
      buffer += String(chunk); const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (predicate(value)) { child.stdout.off('data', data); resolveValue(value); }
        } catch { /* The exit assertion retains fatal process evidence. */ }
      }
    };
    child.stdout.on('data', data); child.once('error', reject);
  });
}

it.skipIf(!imageId || process.platform !== 'linux')('automatically reconciles an uncancelled offline exit and recovers partial output after service restart', async () => {
  const sdk = resolve('dist/index.js'); const cli = resolve('dist/composition/core/cli/internal/entry.js');
  await Promise.all([sdk, cli].map(path => access(path).catch(() => {
    throw new Error('BUILD_REQUIRED: run npm run build before this process proof');
  })));
  const root = await mkdtemp(join(tmpdir(), 'dk-recon-p-'));
  const project = join(root, 'p'), data = join(root, 'd'), configPath = join(project, '.deckent/config.json');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', project, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'input'), 'base\n'); await git('add', 'input'); await git('commit', '-m', 'base');
  const registry = fixtureDockerRegistry(['offline-runtime']);
  registry.profiles[0]!.parameters = { ...registry.profiles[0]!.parameters, imageId,
    argv: ['node', '-e', "const f=require('node:fs');f.appendFileSync('/workspace/starts','1');f.writeFileSync('/workspace/ready','yes');const t=setInterval(()=>{if(f.existsSync('/workspace/release')){clearInterval(t);process.stdout.write('offline-output');process.stderr.write('offline-error');process.exit(7)}},10)"] };
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000,
    outputBytes: 65536 };
  const configuration = { layout: { root: data }, artifacts: { maxBytes: 65536 }, inspection: { maxPageSize: 2,
    policyMaxBytes: 65536 }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry },
  cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 2, maxAttempts: 2, retryDelayMs: 50, claimTtlMs: 100 },
  cancellationRuntime: { scopeIds: ['ungranted'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
  reconciliationRuntime: { scopeIds: ['s'], pageSize: 2, maxConcurrentReconciliations: 1, pollIntervalMs: 10,
    failureBackoffMs: 20 }, service: { inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 4,
    maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 },
  execution: { docker, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } };
  await writeFile(configPath, JSON.stringify(configuration));
  const env = { ...process.env, HOME: join(root, 'h') }; const options = { env };
  const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  opened.store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals,
      resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'reconcile', 'recover-output'], scopes: ['s'], principals,
      resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'offline-runtime', dependencies: [],
    acceptanceCriteria: ['exit'] }], criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept seven',
      evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [7] } }] };
  await createRun(project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph }, options);
  const identity = (await reserveRunTasks(project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r',
    expectedRevision: 0 }, options)).reservation.identities[0]!;
  const executeProgram = `const [sdk,project,identity]=process.argv.slice(1);const {executeTask}=await import(sdk);await executeTask(project,JSON.parse(identity),{env:{...process.env,HOME:process.env.HOME}});`;
  const controller = spawn(process.execPath, ['--input-type=module', '-e', executeProgram, sdk, project, JSON.stringify(identity)],
    { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] }) as Child;
  const controllerClosed = closed(controller); let service: Child | undefined; let handle: string | undefined; let endpoint: string | undefined;
  try {
    const record = await poll(async () => {
      const store = await openConfiguredAttemptStore(project, options);
      try {
        const current = await store.store.loadBoundDispatch(identity);
        if (current?.launch !== 'granted') return undefined;
        try { return await readFile(join(current.request.workspace, 'ready'), 'utf8') === 'yes' ? current : undefined; }
        catch { return undefined; }
      } finally { store.store.close(); }
    }, 'WORKER_READY_TIMEOUT');
    endpoint = (record.profile.parameters as { endpoint: string }).endpoint;
    handle = identifyDockerRequest(record.request, { ...docker, workspaceRoot: resolve(data, 'workspaces'),
      uid: userInfo().uid, gid: userInfo().gid }).handle;
    controller.kill('SIGKILL'); await bounded(controllerClosed, controller, 'CONTROLLER_CLOSE_TIMEOUT');
    expect(controller.signalCode).toBe('SIGKILL');
    await writeFile(join(record.request.workspace, 'release'), 'exit');
    await poll(async () => (await exec('/usr/bin/docker', ['--host', endpoint!, 'inspect', '--format', '{{.State.Running}}', handle!]))
      .stdout.trim() === 'false' ? true : undefined, 'WORKER_EXIT_TIMEOUT');
    const changed = structuredClone(configuration) as Record<string, unknown>; delete changed.execution;
    await writeFile(configPath, JSON.stringify(changed)); clearConfigCache();

    service = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env,
      stdio: ['ignore', 'pipe', 'pipe'] }) as Child;
    await bounded(waitForJson(service, value => value.event === 'ready'), service, 'SERVICE_READY_TIMEOUT');
    const settled = await poll(async () => {
      const store = await openConfiguredAttemptStore(project, options);
      try {
        const current = await store.store.loadBoundDispatch(identity);
        return current?.terminal && current.output ? current : undefined;
      } finally { store.store.close(); }
    }, 'AUTONOMOUS_RECONCILIATION_TIMEOUT');
    expect(settled).toMatchObject({ launch: 'granted', terminal: { exitCode: 7 }, output: { schemaVersion: 1 } });
    const artifacts = new FileArtifactStore({ root: resolve(data, 'artifacts'), maxBytes: 65536 });
    const envelope = parseRetainedOutputEnvelope(await artifacts.read('s', settled.output!), identity);
    expect(envelope).toMatchObject({ completeness: 'partial', stdout: 'offline-output', stderr: 'offline-error' });
    const run = await inspectRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, options);
    expect(run.run?.tasks[0]).toMatchObject({ phase: 'evaluating', unresolvedEffects: false });
    expect(run.run?.tasks[0]?.phase).not.toBe('accepted');
    expect(await readFile(join(record.request.workspace, 'starts'), 'utf8')).toBe('1');

    const serviceClosed = closed(service); service.kill('SIGTERM');
    expect(await bounded(serviceClosed, service, 'SERVICE_CLOSE_TIMEOUT')).toBe(0);
  } finally {
    for (const child of [controller, service]) if (child && child.exitCode === null && child.signalCode === null) {
      const closing = child === controller ? controllerClosed : closed(child); child.kill('SIGKILL'); await closing.catch(() => null);
    }
    if (handle && endpoint) await exec('/usr/bin/docker', ['--host', endpoint, 'rm', '-f', handle]).catch(() => undefined);
    clearConfigCache(); await rm(root, { recursive: true, force: true });
  }
}, 45_000);
