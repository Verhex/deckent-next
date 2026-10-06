import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { DockerSupervisor, GitWorkspaceBroker, readLocalOsIdentity } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { advanceConfiguredRun } from '#composition/core/run-progression/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const query = { schemaVersion: 1 as const, scopeId: 's', runId: 'r' };
/** Configured Run whose installation has no `execution` section: every start of its pinned attempt is refused the same way. */
async function fixture(context: TestContext, grants: readonly string[] = ['execute', 'evaluate', 'read-output']) {
  const root = await mkdtemp(join(tmpdir(), 'launch-refusal-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const options = { env: { HOME: home, USERPROFILE: home } }, registry = fixtureDockerRegistry(['fixture']);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p',
    executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry } }));
  if (process.platform === 'win32') {
    await expect(openConfiguredAttemptStore(project, options)).rejects.toMatchObject({ code: 'MANAGED_FILE_UNSUPPORTED' });
    await expect(stat(data)).rejects.toMatchObject({ code: 'ENOENT' });
    context.skip('MANAGED_FILE_UNSUPPORTED: configured refusal receipt requires POSIX private ledger');
  }
  const opened = await openConfiguredAttemptStore(project, options), store = opened.store;
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  const principal = { ...readLocalOsIdentity(), scopeIds: ['s'] }, principals = [{ issuer: principal.issuer, subject: principal.subject }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'fixture', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: grants, scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  const graph = { schemaVersion: 4 as const, revision: 1, tasks: [
    { id: 'a', kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] },
    { id: 'b', kind: 'fixture', dependencies: ['a'], acceptanceCriteria: ['exit'] },
  ], criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
  return { project, options, store };
}

it('a permanent pre-launch refusal closes the attempt once: 10 turns start it once, the task fails and its dependent is skipped', async context => {
  const f = await fixture(context);
  try {
    const worker = vi.spyOn(DockerSupervisor.prototype, 'execute'), allocate = vi.spyOn(GitWorkspaceBroker.prototype, 'allocate');
    const signal = new AbortController().signal; let attempted = 0, failures = 0;
    for (let turn = 0; turn < 10; turn++) {
      try { attempted += (await advanceConfiguredRun(f.project, query, signal, f.options)).attempted; }
      catch (error) { failures++; attempted++; expect(error).toMatchObject({ code: 'EXECUTION_NOT_CONFIGURED' }); }
    }
    expect({ attempted, failures }).toEqual({ attempted: 1, failures: 1 });
    expect(worker).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    const run = (await f.store.loadRun('s', 'r'))!, identity = run.bindings[0]!.identity;
    expect(run.progress.map(task => task.phase)).toEqual(['failed', 'skipped']);
    expect(run.progress[0]!.unresolvedEffects).toBe(false); expect(run.bindings[0]).toMatchObject({ observedKind: 'launch-refused' });
    expect(run.state).toMatchObject({ kind: 'parked', reason: 'dependency-failed' });
    expect(await f.store.loadBoundDispatch(identity)).toBeNull();
    const receipt = await f.store.receipt('s', 'launch-refused-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex'));
    expect(receipt?.snapshot.lastObservation?.result).toEqual({ kind: 'launch-refused', code: 'EXECUTION_NOT_CONFIGURED' });
    // A direct restart of the closed attempt is refused by terminal selection and rewrites nothing.
    await expect(executeConfiguredTask(f.project, identity, f.options)).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
    expect(await f.store.loadRun('s', 'r')).toEqual(run);
  } finally { f.store.close(); }
});

it('a transient refusal (policy denial before the ledger is touched) is not recorded and is retried on the next turn', async context => {
  const f = await fixture(context, ['evaluate', 'read-output']);
  try {
    const identity = (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve', expectedRevision: 0 }, f.options)).reservation.identities[0]!;
    for (let turn = 0; turn < 3; turn++) await expect(executeConfiguredTask(f.project, identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const run = (await f.store.loadRun('s', 'r'))!;
    expect(run.progress[0]).toMatchObject({ phase: 'active', unresolvedEffects: false }); expect(run.bindings[0]).toMatchObject({ observedKind: null });
    expect((await f.store.load('s', identity.attemptId))!.lastObservation).toBeNull();
  } finally { f.store.close(); }
});
