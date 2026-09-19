import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { applyInstallation, createRun, inspectInstallation, inspectRun, requestRunCancellation, reserveRunTasks } from '../../../src/index.js';
import { hashInstallationProfilePayload, parseRetainedOutputEnvelope } from '#engine/index.js';
import { DockerSupervisor, FileArtifactStore, identifyDockerRequest } from '#adapters/index.js';
import { clearConfigCache, loadConfig } from '#platform/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { installationProfile } from '../support/installation-profile.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE, exec = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
type Child = ChildProcess & { stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']> };
const diagnostics = new WeakMap<Child, { stdout: string; stderr: string }>();
function drain(child: Child) { const captured = { stdout: '', stderr: '' }; diagnostics.set(child, captured);
  child.stdout.on('data', chunk => { captured.stdout = `${captured.stdout}${String(chunk)}`.slice(-4096); });
  child.stderr.on('data', chunk => { captured.stderr = `${captured.stderr}${String(chunk)}`.slice(-4096); }); return child; }
function closed(child: Child) { return new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); }); }
async function bounded<T>(promise: Promise<T>, child: Child, label: string, milliseconds = 20_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL');
    const captured = diagnostics.get(child); reject(new Error(`${label}: ${captured?.stderr ?? ''}`)); }, milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function poll<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let count = 0; count < 1_000; count++) { const value = await read(); if (value !== undefined) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 20)); }
  throw new Error(label);
}
function ready(child: Child) {
  return new Promise<void>((resolveReady, reject) => { let buffer = '';
    child.stdout.on('data', chunk => { buffer += String(chunk); const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) try { if (JSON.parse(line).event === 'ready') { resolveReady(); return; } } catch { /* incomplete/non-JSON */ } });
    child.once('error', reject); child.once('close', code => reject(new Error(`SERVICE_CLOSED_${code}: ${diagnostics.get(child)?.stderr ?? ''}`)));
  });
}
function rehash<T extends ReturnType<typeof installationProfile>>(profile: T): T {
  profile.profile.digest = hashInstallationProfilePayload({ ...profile, profile: { id: profile.profile.id, version: profile.profile.version } }); return profile;
}

it.skipIf(process.platform !== 'linux')('recovers installed offline completion and cancellation after clients and service exit', async () => {
  if (!imageId) throw new Error('DECKENT_TEST_DOCKER_IMAGE is required');
  await access(cli).catch(() => { throw new Error('BUILD_REQUIRED: run npm run build before this process proof'); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-installed-recovery-')); await chmod(root, 0o700);
  let preserveRoot = false;
  try {
  const project = join(root, 'project'), data = join(root, 'relocated-data'); await mkdir(project, { mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', project, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'input'), 'base\n'); await git('add', 'input'); await git('commit', '-m', 'base');
  const profile = installationProfile({ root: data, images: [imageId!, imageId!] });
  const principal = { issuer: hostname(), subject: String(userInfo().uid) }, principals = [principal];
  const config = profile.configuration as typeof profile.configuration & Record<string, unknown>;
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
  const { executable: hostExecutable, ...taskDocker } = docker; void hostExecutable;
  config.execution.docker = docker; config.execution.git = { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 };
  config.admission.inFlightSlots = 2; profile.pool.capacity.inFlightSlots = 2;
  const profiles = config.admission.registry.profiles;
  profiles[0]!.parameters = { ...profiles[0]!.parameters, ...taskDocker,
    argv: ['node', '-e', "const f=require('node:fs');f.appendFileSync('/workspace/starts','1');f.writeFileSync('/workspace/ready','yes');const t=setInterval(()=>{if(f.existsSync('/workspace/release')){clearInterval(t);process.stdout.write('offline-output');process.stderr.write('offline-error');process.exit(7)}},10)"] };
  profiles[1]!.parameters = { ...profiles[1]!.parameters, ...taskDocker,
    argv: ['node', '-e', "const f=require('node:fs');f.writeFileSync('/workspace/ready','yes');setInterval(()=>{},1000)"] };
  config.artifacts = { maxBytes: 65536 }; config.inspection = { maxPageSize: 4, policyMaxBytes: 65536 };
  config.cancellation = { maxConcurrentDeliveries: 1, recoveryPageSize: 4, maxAttempts: 3, retryDelayMs: 10, claimTtlMs: 100 };
  config.cancellationRuntime = { scopeIds: ['scope-1'], pollIntervalMs: 20, failureBackoffMs: 20 };
  config.reconciliationRuntime = { scopeIds: ['scope-1'], pageSize: 4, maxConcurrentReconciliations: 1, pollIntervalMs: 20, failureBackoffMs: 20 };
  config.service = { identity: { scopeId: 'scope-1', serviceId: 'service-1' }, inputMaxBytes: 65536, responseMaxBytes: 65536,
    maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 };
  profile.policy.grants = [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope-1'], principals, resource: { kind: 'scope', ids: ['scope-1'] } },
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect', 'cancel'], scopes: ['scope-1'], principals, resource: { kind: 'run', ids: ['offline', 'cancel'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['scope-1'], principals, resource: { kind: 'pool', ids: ['pool-1'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'cancel', 'reconcile', 'recover-output'], scopes: ['scope-1'], principals, resource: { kind: 'attempt', ids: 'all' } },
  ];
  rehash(profile);
  const env = { HOME: join(root, 'home'), PATH: process.env.PATH ?? '/usr/bin:/bin' }, options = { env };
  const evidence = await inspectInstallation(project, profile, { allowShutdown: false, dockerExecutable: '/usr/bin/docker' });
  await applyInstallation(project, profile, { allowShutdown: false, dockerExecutable: '/usr/bin/docker', proposalDigest: evidence.proposalDigest, acceptCustom: true });
  const graph = (kind: string, exitCode: number) => ({ schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'task', kind, dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'exit', evaluator: { id: 'custom-exit', version: 7 }, parameters: { acceptedExitCodes: [exitCode] } }] });
  const children = new Set<Child>(); let service: Child | undefined; let serviceClose: Promise<number | null> | undefined;
  let firstHandle: string | undefined, secondHandle: string | undefined, endpoint: string | undefined;
  let testFailed = false, testFailure: unknown, cleanupFailure: AggregateError | undefined;
  type Identity = { scopeId: string; runId: string; taskId: string; attemptId: string; generation: number; layoutRevision: string };
  let firstIdentity: Identity | undefined, secondIdentity: Identity | undefined;
  const start = () => { const child = drain(spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] }) as Child);
    children.add(child); return child; };
  const executeChild = (identity: Identity) => {
    const child = drain(spawn(process.execPath, [cli, 'task', 'execute', '--scope', identity.scopeId, '--run', identity.runId, '--task', identity.taskId,
      '--attempt', identity.attemptId, '--generation', String(identity.generation), '--layout-revision', identity.layoutRevision, '--json'],
    { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] }) as Child); children.add(child); return child; };
  try {
    service = start(); serviceClose = closed(service); await bounded(ready(service), service, 'INITIAL_SERVICE_READY');
    await createRun(project, { schemaVersion: 1, commandId: 'create-offline', scopeId: 'scope-1', runId: 'offline', graph: graph('kind-1', 7) }, options);
    const first = firstIdentity = (await reserveRunTasks(project, { schemaVersion: 1, commandId: 'reserve-offline', scopeId: 'scope-1', runId: 'offline', expectedRevision: 0 }, options)).reservation.identities[0]!;
    const firstClient = executeChild(first), firstClosed = closed(firstClient);
    const firstRecord = await poll(async () => { const opened = await openConfiguredAttemptStore(project, options); try {
      const record = await opened.store.loadBoundDispatch(first); if (!record) return undefined;
      try { return await readFile(join(record.request.workspace, 'ready'), 'utf8') === 'yes' ? record : undefined; } catch { return undefined; }
    } finally { opened.store.close(); } }, 'FIRST_WORKER_READY');
    endpoint = (firstRecord.profile.parameters as { endpoint: string }).endpoint;
    firstHandle = identifyDockerRequest(firstRecord.request, { ...docker, workspaceRoot: resolve(data, 'workspaces'), uid: userInfo().uid, gid: userInfo().gid }).handle;
    firstClient.kill('SIGKILL'); await bounded(firstClosed, firstClient, 'FIRST_CLIENT_CLOSE');
    service.kill('SIGKILL'); await bounded(serviceClose, service, 'FIRST_SERVICE_CLOSE');
    await writeFile(join(firstRecord.request.workspace, 'release'), 'yes');
    await poll(async () => (await exec('/usr/bin/docker', ['--host', endpoint!, 'inspect', '--format', '{{.State.Running}}', firstHandle!])).stdout.trim() === 'false' ? true : undefined, 'FIRST_EXIT');
    service = start(); serviceClose = closed(service); await bounded(ready(service), service, 'RESTART_ONE_READY');
    const settled = await poll(async () => { const opened = await openConfiguredAttemptStore(project, options); try { const record = await opened.store.loadBoundDispatch(first);
      return record?.terminal && record.output ? record : undefined; } finally { opened.store.close(); } }, 'OFFLINE_RECOVERY');
    expect(settled.terminal).toMatchObject({ exitCode: 7 });
    const envelope = parseRetainedOutputEnvelope(await new FileArtifactStore({ root: resolve(data, 'artifacts'), maxBytes: 65536 }).read('scope-1', settled.output!), first);
    expect(envelope).toMatchObject({ completeness: 'partial', stdout: 'offline-output', stderr: 'offline-error' });
    expect((await inspectRun(project, { schemaVersion: 1, scopeId: 'scope-1', runId: 'offline' }, options)).run?.tasks[0]).toMatchObject({ phase: 'evaluating', unresolvedEffects: false });
    expect(await readFile(join(firstRecord.request.workspace, 'starts'), 'utf8')).toBe('1');

    await createRun(project, { schemaVersion: 1, commandId: 'create-cancel', scopeId: 'scope-1', runId: 'cancel', graph: graph('kind-2', 0) }, options);
    const second = secondIdentity = (await reserveRunTasks(project, { schemaVersion: 1, commandId: 'reserve-cancel', scopeId: 'scope-1', runId: 'cancel', expectedRevision: 0 }, options)).reservation.identities[0]!;
    const secondClient = executeChild(second), secondClosed = closed(secondClient);
    const secondRecord = await poll(async () => { const opened = await openConfiguredAttemptStore(project, options); try { const record = await opened.store.loadBoundDispatch(second); if (!record) return undefined;
      try { return await readFile(join(record.request.workspace, 'ready'), 'utf8') === 'yes' ? record : undefined; } catch { return undefined; } } finally { opened.store.close(); } }, 'SECOND_WORKER_READY');
    secondHandle = identifyDockerRequest(secondRecord.request, { ...docker, workspaceRoot: resolve(data, 'workspaces'), uid: userInfo().uid, gid: userInfo().gid }).handle;
    secondClient.kill('SIGKILL'); await bounded(secondClosed, secondClient, 'SECOND_CLIENT_CLOSE');
    service.kill('SIGKILL'); await bounded(serviceClose, service, 'SECOND_SERVICE_CLOSE');
    await requestRunCancellation(project, { schemaVersion: 1, commandId: 'cancel-run', action: 'cancel', scopeId: 'scope-1', runId: 'cancel', expectedRevision: 1 }, options);
    service = start(); serviceClose = closed(service); await bounded(ready(service), service, 'RESTART_TWO_READY');
    await poll(async () => (await exec('/usr/bin/docker', ['--host', endpoint!, 'inspect', '--format', '{{.State.Running}}', secondHandle!])).stdout.trim() === 'false' ? true : undefined, 'SECOND_STOPPED');
    const ledger = resolve(data, 'state/ledger.db');
    const busyTimeoutMs = (await loadConfig(project, { ...options, heal: false })).storage.sqlite.busyTimeoutMs;
    expect(busyTimeoutMs).toBeGreaterThan(0);
    await poll(async () => { const db = new DatabaseSync(ledger, { readOnly: true, timeout: busyTimeoutMs }); try { const row = db.prepare('SELECT record FROM cancellation_deliveries WHERE scope_id=? AND attempt_id=?').get('scope-1', second.attemptId) as { record: string } | undefined;
      return row && JSON.parse(row.record).state === 'terminal' ? row : undefined; } finally { db.close(); } }, 'CANCELLATION_DURABLE');
    const proof = await openConfiguredAttemptStore(project, options); try { expect(await proof.store.load('scope-1', second.attemptId)).toMatchObject({ cancelRequested: true, lastObservation: { result: { kind: 'exited' } } }); } finally { proof.store.close(); }
    const finalClose = serviceClose; service.kill('SIGTERM'); expect(await bounded(finalClose, service, 'FINAL_SERVICE_CLOSE')).toBe(0);
  } catch (error) { testFailed = true; testFailure = error; } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const ending = closed(child); child.kill('SIGKILL'); await ending.catch(() => null); }
    const releases = await Promise.allSettled([firstIdentity, secondIdentity].filter((identity): identity is Identity => !!identity).map(async identity => {
      const opened = await openConfiguredAttemptStore(project, options);
      try {
        const record = await opened.store.loadBoundDispatch(identity);
        if (record) await (await DockerSupervisor.restoreProfile(record.profile)).release(record.request);
      } finally { opened.store.close(); }
    }));
    clearConfigCache();
    const failures = releases.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) { preserveRoot = true;
      cleanupFailure = new AggregateError([...failures.map(failure => failure.reason), ...(testFailed ? [testFailure] : [])],
        `INSTALLED_RECOVERY_CLEANUP_FAILED root=${root}`); }
  }
  if (cleanupFailure) throw cleanupFailure;
  if (testFailed) throw testFailure;
  } finally { clearConfigCache(); if (!preserveRoot) await rm(root, { recursive: true, force: true }); }
}, 90_000);
