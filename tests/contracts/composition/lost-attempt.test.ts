import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { arch, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { DockerSupervisor, FileArtifactStore, readLocalOsIdentity } from '#adapters/index.js';
import { DispatchApplication, SupervisorError, type SandboxRequest, type SupervisorProfile } from '#engine/index.js';
import { clearConfigCache, prepareProductDirectory, productResourcePath } from '#platform/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { markLostConfiguredAttempt } from '#composition/core/execution/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Two independent tasks on a one-slot pool; task `a` is reserved. Its workspace (and so any executor heartbeat) never exists. */
async function fixture(context: TestContext, attemptActions: readonly string[] = ['execute', 'reconcile']) {
  const root = await mkdtemp(join(tmpdir(), 'lost-attempt-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const options = { env: { HOME: home, USERPROFILE: home } }, registry = fixtureDockerRegistry(['fixture']);
  const { argv: _argv, ...docker } = registry.profiles[0]!.parameters; void _argv;
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p',
    executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry }, execution: { docker: { executable: '/usr/bin/docker', ...docker },
    git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  if (process.platform === 'win32') {
    await expect(openConfiguredAttemptStore(project, options)).rejects.toMatchObject({ code: 'MANAGED_FILE_UNSUPPORTED' });
    await expect(stat(data)).rejects.toMatchObject({ code: 'ENOENT' });
    context.skip('MANAGED_FILE_UNSUPPORTED: worker-loss hold requires POSIX private ledger');
  }
  const opened = await openConfiguredAttemptStore(project, options), store = opened.store;
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  const principal = { ...readLocalOsIdentity(), scopeIds: ['s'] }, principals = [{ issuer: principal.issuer, subject: principal.subject }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'fixture', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: attemptActions, scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  const graph = { schemaVersion: 4 as const, revision: 1, tasks: [
    { id: 'a', kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] },
    { id: 'b', kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] },
  ], criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
  const identity = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve-a', expectedRevision: 0 }, options)).reservation.identities[0]!;
  const os = userInfo(), workspaceRoot = await prepareProductDirectory(opened.layout, 'workspaces');
  const profile: SupervisorProfile = { schemaVersion: 1, adapterId: 'docker', adapterVersion: 2, parameters: {
    endpoint: 'unix:///fixture.sock', options: { ...docker, executable: '/usr/bin/docker', workspaceRoot, uid: os.uid, gid: os.gid },
    origin: { hostname: hostname(), platform: process.platform, architecture: arch(), uid: os.uid, gid: os.gid, daemonId: 'fixture' } } };
  const request: SandboxRequest = { protocolVersion: 1, identity, workspace: join(workspaceRoot, 'gone', 'workspace'), argv: ['node', 'task.js'] };
  const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 65536 });
  return { project, options, store, identity, principal, profile, request, artifacts };
}
/** The real dispatch application over the real ledger with a scripted supervisor (no Docker); its grant time is long past the stale window. */
function dispatcher(f: Fixture, execute: (request: SandboxRequest) => Promise<unknown>) {
  const supervisor = { async captureProfile() { return f.profile; }, execute, async observe() { throw new Error('unused'); }, async cancel() { throw new Error('unused'); },
    async recoverOutput() { throw new Error('unused'); }, async release() { throw new Error('unused'); } };
  return new DispatchApplication(f.store, supervisor as never, { async verify() { return f.principal; } }, { async authorize() {} }, f.principal.id, f.artifacts, () => 1);
}
async function recordedGrant(f: Fixture) {
  const claim = { owner: f.principal.id, request: f.request };
  await f.store.claimDispatch({ ...claim, profile: f.profile }); await f.store.grantLaunch({ claim, principal: f.principal, now: 1 });
}
function daemon(state: string) {
  const inspectActivity = vi.fn(async () => ({ handle: 'fixture', state }));
  const restore = vi.spyOn(DockerSupervisor, 'restoreProfile').mockResolvedValue({ inspectActivity } as never);
  return { inspectActivity, restore };
}
const reserveB = (f: Fixture, expectedRevision: number) => reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: `reserve-b-${expectedRevision}`, expectedRevision }, f.options);
const slotHeld = async (f: Fixture) => expect(reserveB(f, (await f.store.loadRun('s', 'r'))!.revision)).rejects.toMatchObject({ code: expect.stringMatching(/^RUN_(CAPACITY_OR_ORDER|POOL_FULL)$/) });
async function expectHeld(f: Fixture, observedKind = 'unknown') {
  const run = (await f.store.loadRun('s', 'r'))!;
  expect(run.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true }); expect(run.bindings[0]).toMatchObject({ observedKind });
  await slotHeld(f);
}

it.for(['unknown', 'throw'] as const)('real execute %s path, worker gone: mark-lost holds the unknown outcome; the task is never failed and the slot stays held', async (path, context) => {
  const f = await fixture(context);
  try {
    const app = dispatcher(f, async () => {
      if (path === 'throw') throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
      return { handle: 'fixture', result: { kind: 'unknown', reasonCode: 'SUPERVISOR_OUTCOME_UNRESOLVED' }, outputCompleteness: 'unavailable', stdout: '', stderr: '', interrupted: false };
    });
    if (path === 'throw') await expect(app.execute(f.request)).rejects.toMatchObject({ code: 'SUPERVISOR_CONTROL_FAILED' });
    else expect((await app.execute(f.request)).kind).toBe('unresolved');
    // The real path leaves granted custody with no terminal and no attempt observation: the task still looks active.
    expect(await f.store.loadBoundDispatch(f.identity)).toMatchObject({ launch: 'granted', terminal: null });
    expect((await f.store.loadRun('s', 'r'))!.progress[0]).toMatchObject({ phase: 'active', unresolvedEffects: false });
    const { inspectActivity } = daemon('missing');
    expect((await markLostConfiguredAttempt(f.project, f.identity, f.options)).hold).toMatchObject({ status: 'held', heartbeat: 'missing', phase: 'reconciling' });
    expect(inspectActivity).toHaveBeenCalledTimes(1);
    await expectHeld(f);
    expect(await f.store.loadBoundDispatch(f.identity)).toMatchObject({ launch: 'granted', terminal: null });
    const receipt = JSON.parse((await f.store.receipt('s', 'unknown-' + createHash('sha256').update(JSON.stringify(f.identity)).digest('hex')))!.command);
    expect(receipt).toMatchObject({ observation: { result: { kind: 'unknown', reasonCode: 'WORKER_LOST' } }, audit: { container: 'missing', heartbeat: 'missing', grantedAt: 1 } });
    expect(receipt.actor.id).toBeTypeOf('string');
    // Replay is idempotent and does not contact the daemon again.
    expect((await markLostConfiguredAttempt(f.project, f.identity, f.options)).hold).toMatchObject({ status: 'held', heartbeat: 'recorded' });
    expect(inspectActivity).toHaveBeenCalledTimes(1);
  } finally { f.store.close(); }
});

it('negative: an executor paused after its grant and before container start resumes inside the held slot; its exit cannot fail, accept or free the task', async context => {
  const f = await fixture(context);
  try {
    let resume!: () => void; const paused = new Promise<void>(resolve => { resume = resolve; }); let reached!: () => void; const atStart = new Promise<void>(resolve => { reached = resolve; });
    const app = dispatcher(f, async () => { reached(); await paused;
      return { handle: 'fixture', result: { kind: 'exited', exitCode: 0 }, outputCompleteness: 'complete', stdout: 'done', stderr: '', interrupted: false }; });
    const running = app.execute(f.request); await atStart;
    daemon('missing');
    expect((await markLostConfiguredAttempt(f.project, f.identity, f.options)).hold).toMatchObject({ status: 'held', phase: 'reconciling' });
    await expectHeld(f);
    resume(); expect((await running).kind).toBe('terminal');
    // The late exit is recorded as evidence, yet the outcome stays held: never failed, never evaluated, slot never released.
    await expectHeld(f, 'exited');
    expect(await f.store.loadBoundDispatch(f.identity)).toMatchObject({ launch: 'granted', terminal: { exitCode: 0 } });
  } finally { f.store.close(); }
});

it('negative: a principal without reconcile authority is refused before any ledger read or daemon contact', async context => {
  const f = await fixture(context, ['execute']);
  try {
    await recordedGrant(f); const { restore } = daemon('missing');
    await expect(markLostConfiguredAttempt(f.project, f.identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(restore).not.toHaveBeenCalled();
    expect((await f.store.loadRun('s', 'r'))!.progress[0]).toMatchObject({ phase: 'active' });
  } finally { f.store.close(); }
});

it('negative: a present container, an unproven executor or no granted launch change nothing', async context => {
  const f = await fixture(context);
  try {
    const { restore } = daemon('running');
    expect((await markLostConfiguredAttempt(f.project, f.identity, f.options)).hold).toMatchObject({ status: 'refused', reason: 'not-launched', phase: 'active' });
    expect(restore).not.toHaveBeenCalled();
    await recordedGrant(f);
    expect((await markLostConfiguredAttempt(f.project, f.identity, f.options)).hold).toMatchObject({ status: 'refused', reason: 'container-present', phase: 'active' });
    vi.restoreAllMocks(); daemon('unknown');
    expect((await markLostConfiguredAttempt(f.project, f.identity, f.options)).hold).toMatchObject({ status: 'refused', reason: 'container-present' });
    expect((await f.store.loadRun('s', 'r'))!.progress[0]).toMatchObject({ phase: 'active', unresolvedEffects: false });
    expect((await f.store.load('s', f.identity.attemptId))!.lastObservation).toBeNull();
  } finally { f.store.close(); }
});
