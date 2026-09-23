import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, it } from 'vitest';
import { applyInstallation, createConfiguredRuntimeClient, inspectInstallation } from '../../../src/index.js';
import { hashInstallationProfilePayload } from '#engine/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { openConfiguredExecution } from '../../../src/composition/core/execution/index.js';
import { installationProfile } from '../support/installation-profile.js';

const exec = promisify(execFile), cli = resolve('dist/composition/core/cli/internal/entry.js'), mcp = resolve('dist/composition/core/mcp/internal/entry.js');
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function bounded<T>(promise: Promise<T>, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function closed(child: ChildProcessWithoutNullStreams) { return new Promise<number | null>(resolve => child.once('close', resolve)); }
/** Service stdout events with arrival time, so a failure message shows which work held a slot (I40 timeline, no retries). */
const serviceEvents: string[] = [];
const timeline = (label: string) => `${label} @${Date.now()}\n${serviceEvents.join('\n')}`;
async function ready(child: ChildProcessWithoutNullStreams, stderr: () => string) {
  let buffered = '';
  serviceEvents.length = 0;
  child.stdout.on('data', chunk => { for (const line of String(chunk).split('\n')) if (line.trim()) serviceEvents.push(`${Date.now()} ${line.slice(0, 400)}`); });
  try {
    await bounded(new Promise<void>((resolveReady, reject) => {
      child.stdout.on('data', chunk => { buffered += String(chunk); for (const line of buffered.split('\n')) {
        try { if (JSON.parse(line).event === 'ready') { resolveReady(); return; } } catch { /* incomplete line */ }
      } });
      child.once('exit', code => reject(new Error(`SERVICE_EXIT_${code}: ${stderr().slice(-4096)}`)));
    }));
  } catch (error) { throw new Error(`SERVICE_READY_FAILED: ${stderr().slice(-4096)}`, { cause: error }); }
}
function rehash<T extends ReturnType<typeof installationProfile>>(profile: T): T {
  profile.profile.digest = hashInstallationProfilePayload({ ...profile, profile: { id: profile.profile.id, version: profile.profile.version } }); return profile;
}

type ContentionRuntime = Awaited<ReturnType<typeof openConfiguredExecution>>;
type ContentionLease = Awaited<ReturnType<ContentionRuntime['workspaces']['openRecorded']>>;
type ContentionIdentity = Parameters<ContentionRuntime['store']['loadBoundDispatch']>[0];
/** Recovers held contention workers from the exact run's recorded dispatches (not from test callbacks) and releases their barrier. */
async function releaseContentionWorkers(runtime: ContentionRuntime): Promise<ContentionIdentity[]> {
  const held = (await runtime.store.listDispatches({ schemaVersion: 1, scopeId: 'scope-1', after: null, limit: 10 })).entries
    .filter(entry => entry.terminal === null && entry.identity.runId === 'run-1');
  for (const entry of held) {
    const recorded = await runtime.workspaces.openRecorded(entry.identity);
    if (recorded) await writeFile(join(recorded.workspace, '.release'), '1');
  }
  return held.map(entry => entry.identity);
}
type ContentionRecord = Awaited<ReturnType<ContentionRuntime['store']['loadBoundDispatch']>>;
/** The real custody operations cleanup crosses; a test replaces one to inject a fault at that boundary. */
type CleanupBoundary = {
  loadBoundDispatch: (runtime: ContentionRuntime, identity: ContentionIdentity) => Promise<ContentionRecord>;
  restoreProfile: (record: NonNullable<ContentionRecord>, identity: ContentionIdentity) => ReturnType<typeof DockerSupervisor.restoreProfile>;
  releaseWorkspace: (runtime: ContentionRuntime, lease: NonNullable<ContentionLease>) => Promise<void>;
};
const cleanupBoundary: CleanupBoundary = {
  loadBoundDispatch: (runtime, identity) => runtime.store.loadBoundDispatch(identity),
  restoreProfile: record => DockerSupervisor.restoreProfile(record.profile),
  releaseWorkspace: (runtime, lease) => runtime.workspaces.release({ schemaVersion: 1, identity: lease.identity, baseCommit: lease.baseCommit }),
};
/** The barrier release is not proof the worker exited: the supervisor's own cancel (kill if running, then inspect) precedes removal. */
async function stopWorker(supervisor: Awaited<ReturnType<typeof DockerSupervisor.restoreProfile>>, request: NonNullable<ContentionRecord>['request']) {
  await supervisor.cancel(request); await supervisor.release(request);
}
/** Releases one attempt's worker and workspace. Every stage runs independently; a rejected read is an error, never absence. */
async function releaseCustody(runtime: ContentionRuntime, boundary: CleanupBoundary, identity: ContentionIdentity,
  known: { record: ContentionRecord; lease: ContentionLease }, errors: unknown[]): Promise<void> {
  let { record, lease } = known;
  if (!record) try { record = await boundary.loadBoundDispatch(runtime, identity); } catch (error) { errors.push(error); }
  if (record) try { await stopWorker(await boundary.restoreProfile(record, identity), record.request); } catch (error) { errors.push(error); }
  if (!lease) try { lease = await runtime.workspaces.openRecorded(identity); } catch (error) { errors.push(error); }
  if (lease) try { await boundary.releaseWorkspace(runtime, lease); } catch (error) { errors.push(error); }
}
/** Final sweep after the producer (service) has stopped: release every recorded dispatch and workspace of the exact fixture run. */
async function cleanupContention(runtime: ContentionRuntime, boundary: CleanupBoundary, handled: ContentionIdentity | undefined): Promise<unknown[]> {
  const errors: unknown[] = [];
  const recorded = await runtime.store.listDispatches({ schemaVersion: 1, scopeId: 'scope-1', after: null, limit: 10 }).catch(error => { errors.push(error); return null; });
  for (const entry of recorded?.entries ?? []) {
    if (entry.identity.runId !== 'run-1' || (handled && entry.identity.attemptId === handled.attemptId)) continue;
    await releaseCustody(runtime, boundary, entry.identity, { record: null, lease: null }, errors);
  }
  return errors;
}
/** Witness faults: before-dispatch and after-arrival leave the identity unknown (sweep path); after-found leaves it known. */
type ContentionFault = 'before-dispatch' | 'after-arrival' | 'after-found';
/** Barrier witness: the automatically started worker proves it holds the slot before the manual request, and is released only after the refusal. */
async function witnessContention(client: Client, runtime: ContentionRuntime,
  runtimeClient: ReturnType<typeof createConfiguredRuntimeClient>, found: (value: { identity: ContentionIdentity; lease: ContentionLease }) => void, fault?: ContentionFault) {
  if (fault === 'before-dispatch') throw new Error('INJECTED_WITNESS_FAULT_BEFORE_DISPATCH');
  let identity: ContentionIdentity | undefined, lease: ContentionLease = null, arrived = false;
  for (let tries = 0; !arrived && tries < 400; tries++) {
    const owned = (await runtime.store.listDispatches({ schemaVersion: 1, scopeId: 'scope-1', after: null, limit: 10 })).entries.find(entry => entry.terminal === null);
    if (owned) { identity = owned.identity; lease ??= await runtime.workspaces.openRecorded(identity); if (lease && (!fault || fault === 'after-found')) found({ identity, lease }); }
    arrived = !!lease && await readFile(join(lease.workspace, '.arrived'), 'utf8').then(() => true, () => false);
    if (!arrived) await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!arrived || !identity || !lease) throw new Error(`PROGRESSION_WORKER_DID_NOT_ARRIVE\n${timeline('waited')}`);
  if (fault === 'after-arrival' || fault === 'after-found') throw new Error(`INJECTED_WITNESS_FAULT_${fault.toUpperCase().replace('-', '_')}`);
  const manual = await client.callTool({ name: 'execute_task', arguments: identity });
  expect(manual.isError, timeline('manual execute')).toBe(true);
  expect(JSON.stringify(manual.content)).toContain('RUNTIME_SERVICE_BUSY');
  // Release through the same store-recovered path the failure cleanup uses, not through the found callback.
  expect(await releaseContentionWorkers(runtime)).toEqual([identity]);
  let accepted = false;
  for (let tries = 0; !accepted && tries < 400; tries++) {
    accepted = (await runtimeClient.inspectRun({ schemaVersion: 1, scopeId: 'scope-1', runId: 'run-1' })).run?.tasks.find(task => task.id === 'task-1')?.phase === 'accepted';
    if (!accepted) await new Promise(resolve => setTimeout(resolve, 50));
  }
  expect(accepted, timeline('progression acceptance')).toBe(true);
  const dispatches = (await runtime.store.listDispatches({ schemaVersion: 1, scopeId: 'scope-1', after: null, limit: 10 })).entries;
  expect(dispatches).toHaveLength(1); expect(dispatches[0]!.identity).toEqual(identity);
  return { record: await runtime.store.loadBoundDispatch(identity) };
}

async function installedScenario(mode: string, observed: { root?: string; identity?: ContentionIdentity } = {}, fault?: ContentionFault,
  boundary: CleanupBoundary = cleanupBoundary) {
  const conditional = mode === 'conditional', approvals = mode === 'approval', contention = mode === 'contention';
  const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
  if (!imageId) throw new Error('DECKENT_TEST_DOCKER_IMAGE is required');
  const root = await mkdtemp(join(tmpdir(), 'deckent-installed-service-')); roots.push(root); await chmod(root, 0o700); observed.root = root;
  const project = join(root, 'project'), data = join(root, 'data'), profilePath = join(root, 'profile.json'); await mkdir(project, { mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', project, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'input'), 'base\n'); await git('add', 'input'); await git('commit', '-m', 'base');
  await writeFile(join(project, 'input'), 'owner-wip\n');

  const profile = installationProfile({ root: data, shutdown: true, images: [imageId] });
  const principal = { issuer: hostname(), subject: String(userInfo().uid) }, principals = [principal];
  const docker = profile.configuration.execution.docker;
  Object.assign(docker, { executable: '/usr/bin/docker', imageId, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 });
  profile.configuration.execution.git.gitExecutable = '/usr/bin/git';
  const configured = profile.configuration as typeof profile.configuration & {
    cancellation: { maxConcurrentDeliveries: number; maxAttempts: number; retryDelayMs: number; claimTtlMs: number; recoveryPageSize: number };
    cancellationRuntime: { scopeIds: string[]; pollIntervalMs: number; failureBackoffMs: number };
    service: { identity: { scopeId: string; serviceId: string }; inputMaxBytes: number; responseMaxBytes: number; maxConnections: number;
      maxConcurrentRequests: number; maxConcurrentExecutions: number; headerTimeoutMs: number; shutdownGraceMs: number };
  };
  configured.cancellation = { maxConcurrentDeliveries: 1, maxAttempts: 3, retryDelayMs: 10, claimTtlMs: 100, recoveryPageSize: 2 };
  configured.cancellationRuntime = { scopeIds: ['scope-1'], pollIntervalMs: 50, failureBackoffMs: 50 };
  // Every created Run carries an automatic progression intent and progression executes under the single execution slot.
  // Manual modes keep progression out of the way (I40: its default 1 s poll raced the CLI reserve -> MCP execute window and
  // produced RUNTIME_SERVICE_BUSY under load); contention mode proves that ownership contract explicitly.
  (configured as Record<string, unknown>).runRuntime = { pollIntervalMs: contention ? 50 : 600_000 };
  configured.service = { identity: { scopeId: 'scope-1', serviceId: 'service-1' }, inputMaxBytes: 65536, responseMaxBytes: 65536,
    maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 };
  const selected = profile.configuration.admission.registry.profiles[0]!;
  const { executable: hostExecutable, ...dockerTask } = docker; void hostExecutable;
  selected.parameters = { ...selected.parameters, ...dockerTask,
    // Contention worker: announce arrival, then hold its slot until the test releases it (bounded 60 s, exit 3 if never released).
    argv: ['node', '-e', contention ? "const fs=require('node:fs');fs.writeFileSync('/workspace/.arrived','1');const end=Date.now()+60000;"
      + "(function hold(){const released=fs.existsSync('/workspace/.release');if(released||Date.now()>end){process.stdout.write(fs.readFileSync('/workspace/input','utf8'));"
      + "process.exit(released?0:3)}setTimeout(hold,50)})()"
      : "process.stdout.write(require('node:fs').readFileSync('/workspace/input','utf8'))"] };
  profile.policy.grants = [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope-1'], principals, resource: { kind: 'scope', ids: ['scope-1'] } },
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect', 'cancel'], scopes: ['scope-1'], principals, resource: { kind: 'run', ids: ['run-1'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['scope-1'], principals, resource: { kind: 'pool', ids: ['pool-1'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'evaluate', 'cancel', 'reconcile', 'recover-output'], scopes: ['scope-1'], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'shutdown', effect: 'allow', actions: ['shutdown'], scopes: ['scope-1'], principals, resource: { kind: 'service', ids: ['service-1'] } },
  ];
  if (approvals) profile.policy.grants.push(
    { id: 'approve-task', effect: 'require-approval', actions: ['execute'], scopes: ['scope-1'], principals, resource: { kind: 'task', ids: ['held'] } },
    { id: 'approval', effect: 'allow', actions: ['inspect', 'decide', 'renew'], scopes: ['scope-1'], principals, resource: { kind: 'approval', ids: 'all' } },
  );
  await writeFile(profilePath, JSON.stringify(rehash(profile)), { mode: 0o600 });
  const env = { HOME: join(root, 'home'), PATH: process.env.PATH ?? '/usr/bin:/bin' }, options = { env };
  const evidence = await inspectInstallation(project, profile, { allowShutdown: true, dockerExecutable: '/usr/bin/docker' });
  const installed = await applyInstallation(project, profile, { allowShutdown: true, dockerExecutable: '/usr/bin/docker', proposalDigest: evidence.proposalDigest, acceptCustom: true });
  expect(installed).toMatchObject({ status: 'installed', trust: { mode: 'operator-custom', publisherVerification: 'unverified' } });

  let service: ChildProcessWithoutNullStreams | undefined, serviceClosed: Promise<number | null> | undefined, serviceErr = '';
  let runtime: Awaited<ReturnType<typeof openConfiguredExecution>> | undefined;
  let record: Awaited<ReturnType<Awaited<ReturnType<typeof openConfiguredExecution>>['store']['loadBoundDispatch']>> = null;
  let lease: Awaited<ReturnType<Awaited<ReturnType<typeof openConfiguredExecution>>['workspaces']['openRecorded']>> = null;
  let identity: { scopeId: string; runId: string; taskId: string; attemptId: string; generation: number; layoutRevision: string } | undefined;
  let runtimeClient: ReturnType<typeof createConfiguredRuntimeClient> | undefined;
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', project], env, stderr: 'pipe' });
  const client = new Client({ name: 'installed-runtime-service', version: '1' });
  const cleanupErrors: unknown[] = [];
  let primary: { error: unknown } | undefined;
  // Primary outcome is captured so cleanup runs on success, return and throw alike; both are reported at one exit.
  try {
    service = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
    service.stderr.on('data', chunk => { serviceErr += String(chunk); }); serviceClosed = closed(service);
    await ready(service, () => serviceErr);
    runtime = await openConfiguredExecution(project, project, options);
    runtimeClient = createConfiguredRuntimeClient(project, options);
    const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'task-1', kind: 'kind-1', dependencies: [], acceptanceCriteria: ['exit'] }],
      criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero', evaluator: { id: 'custom-exit', version: 7 }, parameters: { acceptedExitCodes: [0] } }] };
    if (approvals) graph.tasks.unshift({ ...graph.tasks[0]!, id: 'held' });
    if (conditional) graph.tasks.push({ ...graph.tasks[0]!, id: 'not-selected' }, { ...graph.tasks[0]!, id: 'join', dependencies: ['task-1', 'not-selected'] });
    const branch = { schemaVersion: 1 as const, input: { id: 'fact', revision: 'fact-1', value: true }, whenTrue: 'task-1', whenFalse: 'not-selected', join: 'join' };
    if (contention) { await client.connect(transport); serviceEvents.push(`${Date.now()} [test] mcp connected before admission`); }
    const created = await runtimeClient.createRun({ schemaVersion: 1, commandId: 'create', scopeId: 'scope-1', runId: 'run-1', graph, ...(conditional ? { branch } : {}) });
    if (conditional) expect(created.admission.run.branch?.notSelectedTaskId).toBe('not-selected');
    if (contention) {
      const witnessed = await witnessContention(client, runtime, runtimeClient, found => { identity = found.identity; lease = found.lease; observed.identity = found.identity; }, fault);
      record = witnessed.record;
      const descriptor = await runtimeClient.describeService();
      await runtimeClient.shutdownService({ schemaVersion: 1, commandId: 'shutdown', serviceId: 'service-1', instanceId: descriptor.instanceId, reason: 'test complete' });
      expect(await bounded(serviceClosed)).toBe(0);
    } else {
    const reservation = JSON.parse((await exec(process.execPath, [cli, 'run', 'reserve', '--scope', 'scope-1', '--id', 'run-1', '--command-id', 'reserve', '--expected-revision', '0', '--json'], { cwd: project, env })).stdout);
    identity = reservation.reservation.identities[0]; serviceEvents.push(`${Date.now()} [test] reserved ${identity?.attemptId}`);
    await client.connect(transport); serviceEvents.push(`${Date.now()} [test] mcp connected, execute_task`);
    const execution = await client.callTool({ name: 'execute_task', arguments: identity });
    expect(execution.isError, `${JSON.stringify(execution.content)}\n${timeline('execute_task returned')}`).not.toBe(true);
    const evaluation = await client.callTool({ name: 'evaluate_task', arguments: { schemaVersion: 1, commandId: 'evaluate', identity, expectedRevision: 2 } });
    expect(evaluation.isError).not.toBe(true);
    expect((evaluation.structuredContent as { evaluation: { run: { tasks: { id: string; phase: string }[] } } }).evaluation.run.tasks.find(task => 'id' in task && task.id === 'task-1')!.phase).toBe('accepted');
    expect((await runtimeClient.inspectRun({ schemaVersion: 1, scopeId: 'scope-1', runId: 'run-1' })).run?.tasks.find(task => task.id === 'task-1')?.phase).toBe('accepted');
    record = await runtime.store.loadBoundDispatch(identity); lease = await runtime.workspaces.openRecorded(identity);
    const output = JSON.parse(new TextDecoder().decode(await runtime.artifacts.read('scope-1', record!.output!)));
    expect(output.stdout).toBe('base\n'); expect(output.stdout).not.toContain('owner-wip');
    if (conditional) {
      const next = await runtimeClient.reserveRunTasks({ schemaVersion: 1, commandId: 'reserve-join', scopeId: 'scope-1', runId: 'run-1', expectedRevision: 3 });
      expect(next.reservation.identities.map(item => item.taskId)).toEqual(['join']);
      const inspected = await runtimeClient.inspectRun({ schemaVersion: 1, scopeId: 'scope-1', runId: 'run-1' });
      expect(inspected.run?.tasks.some(task => task.id === 'not-selected')).toBe(false);
    }
    if (approvals) {
      const query = { schemaVersion: 1, scopeId: 'scope-1', afterId: null, limit: 10 };
      const pending = await runtimeClient.listApprovals(query) as { request: { approvalId: string; taskId: string }; status: string }[];
      expect(pending).toHaveLength(1); expect(pending[0]).toMatchObject({ status: 'pending', request: { taskId: 'held' } });
      const command = { schemaVersion: 1, scopeId: 'scope-1', approvalId: pending[0]!.request.approvalId,
        commandId: 'allow-held', expectedRevision: 0, decision: 'allow', reason: 'Approve exact held task' };
      const commandPath = join(root, 'approval.json'); await writeFile(commandPath, JSON.stringify(command));
      const [cliDecision, mcpDecision] = await Promise.all([
        exec(process.execPath, [cli, 'approval', 'decide', '--input', commandPath, '--json'], { cwd: project, env }),
        client.callTool({ name: 'decide_approval', arguments: command }),
      ]);
      expect(mcpDecision.isError, JSON.stringify(mcpDecision.content)).not.toBe(true);
      expect(JSON.parse(cliDecision.stdout)).toEqual(mcpDecision.structuredContent);
      const replay = await runtimeClient.reserveRunTasks({ schemaVersion: 1, scopeId: 'scope-1', runId: 'run-1', commandId: 'reserve', expectedRevision: 0 });
      expect(replay.reservation.identities.map(value => value.taskId)).toEqual(['task-1']);
      const fresh = await runtimeClient.reserveRunTasks({ schemaVersion: 1, scopeId: 'scope-1', runId: 'run-1', commandId: 'reserve-approved', expectedRevision: 3 });
      expect(fresh.reservation.identities.map(value => value.taskId)).toEqual(['held']);
      const approvedIdentity = fresh.reservation.identities[0]!;
      try {
        expect((await client.callTool({ name: 'execute_task', arguments: approvedIdentity })).isError).not.toBe(true);
        expect((await client.callTool({ name: 'evaluate_task', arguments: { schemaVersion: 1, commandId: 'evaluate-held', identity: approvedIdentity, expectedRevision: 5 } })).isError).not.toBe(true);
        expect((await runtimeClient.inspectRun({ schemaVersion: 1, scopeId: 'scope-1', runId: 'run-1' })).run?.tasks.every(task => task.phase === 'accepted')).toBe(true);
        expect(await git('diff', '--', 'input')).toContain('+owner-wip');
      } finally {
        const approvedRecord = await runtime.store.loadBoundDispatch(approvedIdentity);
        if (approvedRecord) await (await DockerSupervisor.restoreProfile(approvedRecord.profile)).release(approvedRecord.request);
        const approvedLease = await runtime.workspaces.openRecorded(approvedIdentity);
        if (approvedLease) await runtime.workspaces.release({ schemaVersion: 1, identity: approvedLease.identity, baseCommit: approvedLease.baseCommit });
      }
    }
    const descriptor = await runtimeClient.describeService();
    await runtimeClient.shutdownService({ schemaVersion: 1, commandId: 'shutdown', serviceId: 'service-1', instanceId: descriptor.instanceId, reason: 'test complete' });
    expect(await bounded(serviceClosed)).toBe(0);
    }
  } catch (error) { primary = { error }; }
  {
    // Contention: release held barriers, stop the producer (service + its progression), then sweep recorded custody.
    if (contention && runtime) await releaseContentionWorkers(runtime).catch(error => { cleanupErrors.push(error); return []; });
    await client.close().catch(() => undefined); await transport.close().catch(() => undefined);
    if (contention && service && service.exitCode === null && service.signalCode === null) { service.kill('SIGKILL'); await serviceClosed?.catch(() => null); }
    if (contention && runtime) cleanupErrors.push(...await cleanupContention(runtime, boundary, identity));
    // Manual modes keep their best-effort cleanup (errors discarded); contention reports every custody-stage failure.
    if (runtime && identity) await releaseCustody(runtime, boundary, identity, { record, lease }, contention ? cleanupErrors : []);
    try { runtime?.store.close(); } catch (error) { if (contention) cleanupErrors.push(error); }
    if (service && service.exitCode === null && service.signalCode === null) { service.kill('SIGKILL'); await serviceClosed?.catch(() => null); }
    await rm(profilePath, { force: true });
  }
  settleScenario(primary, cleanupErrors);
}

/** One exit: the primary failure and every cleanup failure are reported; cleanup errors never become a leak-free success. */
function settleScenario(primary: { error: unknown } | undefined, cleanupErrors: readonly unknown[]): void {
  if (primary && cleanupErrors.length) throw new AggregateError([primary.error, ...cleanupErrors], 'SCENARIO_AND_CLEANUP_FAILED');
  if (primary) throw primary.error;
  if (cleanupErrors.length) throw new AggregateError([...cleanupErrors], 'CONTENTION_CLEANUP_FAILED');
}

type DockerCommand = (args: readonly string[]) => Promise<{ stdout: string }>;
const dockerCommand: DockerCommand = args => exec('/usr/bin/docker', [...args]);
/** Running containers (docker ps), or every container with `all` (ps -a). An inspect failure counts as absence only when the container verifiably vanished. */
async function fixtureContainers(root: string, docker: DockerCommand = dockerCommand, all = false): Promise<string[]> {
  const list = all ? ['ps', '-a', '-q', '--no-trunc'] : ['ps', '-q', '--no-trunc'];
  const ids = (await docker(list)).stdout.split('\n').filter(Boolean);
  const owned: string[] = [];
  for (const id of ids) {
    let mounts: string;
    try { mounts = (await docker(['inspect', '-f', '{{range .Mounts}}{{.Source}} {{end}}', id])).stdout; }
    catch (error) {
      const still = (await docker([...list, '--filter', `id=${id}`])).stdout.split('\n').filter(Boolean);
      if (still.length) throw new Error(`FIXTURE_CONTAINER_UNINSPECTABLE:${id}`, { cause: error });
      continue;
    }
    if (mounts.includes(root)) owned.push(id);
  }
  return owned;
}

it('the cleanup oracle fails on cleanup errors and on uninspectable running containers', async () => {
  expect(() => settleScenario(undefined, [new Error('INJECTED_CLEANUP_FAULT')])).toThrow('CONTENTION_CLEANUP_FAILED');
  const combined = (() => { try { settleScenario({ error: new Error('PRIMARY') }, [new Error('INJECTED_CLEANUP_FAULT')]); } catch (error) { return error as AggregateError; } })();
  expect(combined?.message).toBe('SCENARIO_AND_CLEANUP_FAILED'); expect(combined?.errors.map(error => (error as Error).message)).toEqual(['PRIMARY', 'INJECTED_CLEANUP_FAULT']);
  expect(() => settleScenario({ error: new Error('PRIMARY') }, [])).toThrow('PRIMARY');
  expect(() => settleScenario(undefined, [])).not.toThrow();
  const fake = (running: string[], inspectable: Record<string, string>): DockerCommand => async args => {
    if (args[0] === 'ps') return { stdout: (args.includes('--filter') ? running.filter(id => args.at(-1) === `id=${id}`) : running).join('\n') };
    const mounts = inspectable[String(args.at(-1))]; if (mounts === undefined) throw new Error('inspect failed'); return { stdout: mounts };
  };
  await expect(fixtureContainers('/tmp/root-a', fake(['c1'], {}))).rejects.toThrow('FIXTURE_CONTAINER_UNINSPECTABLE:c1');
  const vanishing: DockerCommand = async args => args[0] === 'ps' ? { stdout: args.includes('--filter') ? '' : 'c1' } : Promise.reject(new Error('gone'));
  await expect(fixtureContainers('/tmp/root-a', vanishing)).resolves.toEqual([]);
  await expect(fixtureContainers('/tmp/root-a', fake(['c1', 'c2'], { c1: '/tmp/root-a/data ', c2: '/other ' }))).resolves.toEqual(['c1']);
});

it.skipIf(process.platform !== 'linux').each(['plain', 'conditional', 'approval', 'contention'])('runs installed mode=%s across SDK, CLI and MCP through the configured service', async mode => {
  await installedScenario(mode);
}, 60_000);

it.skipIf(process.platform !== 'linux').each(['before-dispatch', 'after-arrival'] as const)('contention cleanup leaves no fixture worker when the witness fails %s', async fault => {
  const observed: { root?: string } = {};
  await expect(installedScenario('contention', observed, fault)).rejects.toThrow(`INJECTED_WITNESS_FAULT_${fault.toUpperCase().replace('-', '_')}`);
  expect(observed.root).toBeDefined();
  expect(await fixtureContainers(observed.root!, dockerCommand, true)).toEqual([]);
}, 60_000);

it.skipIf(process.platform !== 'linux').each(['custody-read', 'restore'] as const)('known-identity cleanup keeps the primary, reports a %s fault and still releases the workspace', async stage => {
  const observed: { root?: string; identity?: ContentionIdentity } = {};
  const known = (identity: ContentionIdentity) => identity.attemptId === observed.identity?.attemptId;
  const withheld: NonNullable<ContentionRecord>[] = [], released: string[] = [];
  // The fault replaces the known attempt's real operation; its real record is kept only to compensate after the assertions.
  const boundary: CleanupBoundary = {
    loadBoundDispatch: async (runtime, identity) => {
      const record = await cleanupBoundary.loadBoundDispatch(runtime, identity);
      if (stage === 'custody-read' && known(identity)) { if (record) withheld.push(record); throw new Error('INJECTED_CLEANUP_FAULT_CUSTODY_READ'); }
      return record;
    },
    restoreProfile: (record, identity) => {
      if (stage === 'restore' && known(identity)) { withheld.push(record); return Promise.reject(new Error('INJECTED_CLEANUP_FAULT_RESTORE')); }
      return cleanupBoundary.restoreProfile(record, identity);
    },
    releaseWorkspace: async (runtime, lease) => { released.push(lease.identity.attemptId); await cleanupBoundary.releaseWorkspace(runtime, lease); },
  };
  const failure = await installedScenario('contention', observed, 'after-found', boundary).then(() => undefined, (error: unknown) => error);
  try {
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe('SCENARIO_AND_CLEANUP_FAILED');
    expect((failure as AggregateError).errors.map(error => (error as Error).message))
      .toEqual(['INJECTED_WITNESS_FAULT_AFTER_FOUND', `INJECTED_CLEANUP_FAULT_${stage.toUpperCase().replace('-', '_')}`]);
    expect(observed.identity).toBeDefined(); expect(released).toEqual([observed.identity!.attemptId]); expect(withheld).toHaveLength(1);
  } finally {
    for (const record of withheld) await stopWorker(await DockerSupervisor.restoreProfile(record.profile), record.request);
  }
  expect(await fixtureContainers(observed.root!, dockerCommand, true)).toEqual([]);
}, 60_000);
