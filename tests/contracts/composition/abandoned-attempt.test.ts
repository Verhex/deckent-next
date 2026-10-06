import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { arch, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { DockerSupervisor, readLocalOsIdentity } from '#adapters/index.js';
import { applyAttemptObservation, type AttemptIdentity } from '#domain/index.js';
import { clearConfigCache, prepareProductDirectory, productResourcePath } from '#platform/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { closeAbandonedConfiguredAttempt } from '#composition/core/execution/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Two independent tasks on a one-slot pool; task `a` holds the slot with a granted launch and no terminal evidence (its worker is gone). */
async function fixture(context: TestContext, attemptActions: readonly string[] = ['execute', 'reconcile']) {
  const root = await mkdtemp(join(tmpdir(), 'abandoned-attempt-')); roots.push(root);
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
    context.skip('MANAGED_FILE_UNSUPPORTED: abandonment closure requires POSIX private ledger');
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
  // Recorded custody only: the workspace (and so the executor heartbeat) never existed and no Docker process is started.
  const claim = { owner: principal.id, request: { protocolVersion: 1 as const, identity, workspace: join(workspaceRoot, 'gone', 'workspace'), argv: ['node', 'task.js'] } };
  await store.claimDispatch({ ...claim, profile: { schemaVersion: 1, adapterId: 'docker', adapterVersion: 2, parameters: {
    endpoint: 'unix:///fixture.sock', options: { ...docker, executable: '/usr/bin/docker', workspaceRoot, uid: os.uid, gid: os.gid },
    origin: { hostname: hostname(), platform: process.platform, architecture: arch(), uid: os.uid, gid: os.gid, daemonId: 'fixture' },
  } } });
  await store.grantLaunch({ claim, principal, now: 1 });
  return { project, options, store, identity };
}
function daemon(state: string) {
  const inspectActivity = vi.fn(async () => ({ handle: 'fixture', state }));
  const restore = vi.spyOn(DockerSupervisor, 'restoreProfile').mockResolvedValue({ inspectActivity } as never);
  return { inspectActivity, restore };
}
const reserveB = (f: Fixture, expectedRevision: number) => reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: `reserve-b-${expectedRevision}`, expectedRevision }, f.options);

it('a granted launch whose container is absent and whose executor never wrote a heartbeat closes as abandoned and releases the slot', async context => {
  const f = await fixture(context);
  try {
    const before = (await f.store.loadRun('s', 'r'))!;
    await expect(reserveB(f, before.revision)).rejects.toMatchObject({ code: expect.stringMatching(/^RUN_(CAPACITY_OR_ORDER|POOL_FULL)$/) });
    const { inspectActivity } = daemon('missing');
    const result = await closeAbandonedConfiguredAttempt(f.project, f.identity, f.options);
    expect(result.closure).toMatchObject({ status: 'closed', heartbeat: 'missing', phase: 'failed' }); expect(inspectActivity).toHaveBeenCalledTimes(1);
    const run = (await f.store.loadRun('s', 'r'))!;
    expect(run.progress[0]).toMatchObject({ phase: 'failed', unresolvedEffects: false }); expect(run.bindings[0]).toMatchObject({ observedKind: 'abandoned' });
    // No exit is fabricated: the dispatch keeps its granted, non-terminal custody record.
    expect(await f.store.loadBoundDispatch(f.identity)).toMatchObject({ launch: 'granted', terminal: null });
    const receipt = JSON.parse((await f.store.receipt('s', 'abandoned-' + (await import('node:crypto')).createHash('sha256').update(JSON.stringify(f.identity)).digest('hex')))!.command);
    expect(receipt).toMatchObject({ observation: { result: { kind: 'abandoned' } }, audit: { container: 'missing', heartbeat: 'missing', grantedAt: 1 } });
    expect(receipt.actor.id).toBeTypeOf('string');
    // The released slot admits the independent task.
    expect((await reserveB(f, run.revision)).reservation.identities.map(value => value.taskId)).toEqual(['b']);
    // Replay is idempotent and does not touch the daemon again.
    const replay = await closeAbandonedConfiguredAttempt(f.project, f.identity, f.options);
    expect(replay.closure).toMatchObject({ status: 'closed', heartbeat: 'recorded' }); expect(inspectActivity).toHaveBeenCalledTimes(1);
  } finally { f.store.close(); }
});

it('negative: a principal without reconcile authority is refused before any ledger read or daemon contact', async context => {
  const f = await fixture(context, ['execute']);
  try {
    const { restore } = daemon('missing');
    await expect(closeAbandonedConfiguredAttempt(f.project, f.identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(restore).not.toHaveBeenCalled();
    expect((await f.store.loadRun('s', 'r'))!.progress[0]).toMatchObject({ phase: 'active' });
  } finally { f.store.close(); }
});

it('negative: a present container or an unproven executor keeps the attempt open', async context => {
  const f = await fixture(context);
  try {
    daemon('running');
    expect((await closeAbandonedConfiguredAttempt(f.project, f.identity, f.options)).closure).toMatchObject({ status: 'refused', reason: 'container-present', phase: 'active' });
    vi.restoreAllMocks(); daemon('unknown');
    expect((await closeAbandonedConfiguredAttempt(f.project, f.identity, f.options)).closure).toMatchObject({ status: 'refused', reason: 'container-present' });
    expect((await f.store.loadRun('s', 'r'))!.progress[0]).toMatchObject({ phase: 'active' }); expect((await f.store.load('s', f.identity.attemptId))!.lastObservation).toBeNull();
  } finally { f.store.close(); }
});

it('negative: an unknown outcome is never closed — uncertain effects stay held and the daemon is not even asked', async context => {
  const f = await fixture(context);
  try {
    await recordUnknown(f.store, f.identity);
    const { restore } = daemon('missing');
    expect((await closeAbandonedConfiguredAttempt(f.project, f.identity, f.options)).closure).toMatchObject({ status: 'refused', reason: 'effects-unresolved', phase: 'reconciling' });
    expect(restore).not.toHaveBeenCalled();
    const run = (await f.store.loadRun('s', 'r'))!;
    expect(run.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true }); expect(run.bindings[0]).toMatchObject({ observedKind: 'unknown' });
  } finally { f.store.close(); }
});

async function recordUnknown(store: Fixture['store'], identity: AttemptIdentity) {
  const attempt = (await store.load('s', identity.attemptId))!;
  const next = applyAttemptObservation(attempt, { protocolVersion: 1, identity, sequence: 1, eventId: 'lost', result: { kind: 'unknown', reasonCode: 'SUPERVISOR_OUTCOME_UNRESOLVED' } }, attempt.revision);
  await store.commit({ commandId: 'unknown-observation', command: '{}', snapshot: next, expectedRevision: attempt.revision });
  const run = (await store.loadRun('s', 'r'))!;
  await store.projectRunAttempt({ commandId: 'unknown-project', actor: { id: 'op', issuer: 'test', subject: 'op' }, scopeId: 's', runId: 'r', attemptId: identity.attemptId, expectedRevision: run.revision });
}
