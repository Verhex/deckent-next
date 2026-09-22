import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { projectRunView } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = Object.freeze({ busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const });
const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify fixture task', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const identityOf = (runId: string) => ({ runId, scopeId: 's', taskId: 't', attemptId: `attempt-${runId}`, layoutRevision: 'l', generation: 1 });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-cancel-settlement-')); roots.push(root);
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), options, 'allow', custodyProfiles); stores.push(store);
  // A tight shared pool makes capacity release observable: the second Run can only reserve after the first frees its slot.
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'tight', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  const admit = async (runId: string) => {
    const identity = identityOf(runId);
    await store.createRun({ commandId: `create-${runId}`, actor, identity: { runId, scopeId: 's', layoutRevision: 'l' }, now: 0, graph, execution: fixtureExecution(graph),
      policy: { schemaVersion: 2, poolId: 'tight', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
    return identity;
  };
  const reserve = (runId: string) => store.reserveRunTasks({ commandId: `reserve-${runId}`, actor, scopeId: 's', runId, expectedRevision: 0, now: 0, identities: [identityOf(runId)] });
  const cancel = (runId: string, expectedRevision: number) => store.cancelRun({ commandId: `cancel-${runId}`, actor, scopeId: 's', runId, expectedRevision });
  const phase = async (runId: string) => (await store.loadRun('s', runId))!.progress[0]!.phase;
  const claim = (runId: string) => ({ owner: 'fixture', request: { protocolVersion: 1 as const, identity: identityOf(runId), workspace: '/recorded/workspace', argv: ['recorded-tool'] } });
  return { store, admit, reserve, cancel, phase, claim };
}

it('prevents an unlaunched cancel-requested attempt inside the cancellation transaction and frees the pool slot', async () => {
  const f = await fixture(); await f.admit('r1'); await f.reserve('r1');
  await f.admit('r2');
  await expect(f.reserve('r2')).rejects.toMatchObject({ code: 'RUN_POOL_FULL' });
  const receipt = await f.cancel('r1', 1);
  expect(receipt.snapshot.progress[0]).toMatchObject({ phase: 'cancelled', unresolvedEffects: false });
  expect(receipt.snapshot.cancelRequested).toBe(true);
  expect(projectRunView(receipt.snapshot).tasks[0]).toMatchObject({ phase: 'cancelled', cancellation: { reason: 'prevented-before-launch' } });
  expect((await f.reserve('r2')).snapshot.progress[0]!.phase).toBe('active');
  expect(await f.store.settleCancelledAttempt(identityOf('r1'))).toEqual({ status: 'already-cancelled', phase: 'cancelled' });
  // Replay returns the same receipt; a late launch claim is refused by durable intent.
  expect(await f.cancel('r1', 1)).toEqual(receipt);
  await expect(f.store.claimDispatch(dispatchAdmission(f.claim('r1')))).rejects.toMatchObject({ code: 'DISPATCH_NOT_ADMITTED' });
});

it('settles a launched worker killed after cancellation when its terminal exit is recorded', async () => {
  const f = await fixture(); await f.admit('r1'); await f.reserve('r1');
  const claim = f.claim('r1');
  await f.store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(f.store, claim);
  const cancelled = await f.cancel('r1', 1);
  expect(cancelled.snapshot.progress[0]!.phase).toBe('active');
  expect(await f.store.settleCancelledAttempt(identityOf('r1'))).toEqual({ status: 'not-settleable', phase: 'active' });
  await f.store.finishDispatch(claim, { handle: 'worker-1', exitCode: 137, interrupted: false });
  expect(await f.phase('r1')).toBe('cancelled');
  expect(projectRunView((await f.store.loadRun('s', 'r1'))!).tasks[0]).toMatchObject({ cancellation: { reason: 'exited-under-cancellation' } });
  await f.admit('r2'); expect((await f.reserve('r2')).snapshot.progress[0]!.phase).toBe('active');
});

it('settles an attempt that exited before cancellation instead of leaving it evaluating, and never touches accepted work', async () => {
  const f = await fixture(); await f.admit('r1'); await f.reserve('r1');
  const claim = f.claim('r1');
  await f.store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(f.store, claim);
  await f.store.finishDispatch(claim, { handle: 'worker-1', exitCode: 0, interrupted: false });
  expect(await f.phase('r1')).toBe('evaluating');
  const revision = (await f.store.loadRun('s', 'r1'))!.revision;
  expect((await f.cancel('r1', revision)).snapshot.progress[0]!.phase).toBe('cancelled');
  expect(await f.store.settleCancelledAttempt(identityOf('r1'))).toEqual({ status: 'already-cancelled', phase: 'cancelled' });
  await f.admit('r2'); expect((await f.reserve('r2')).snapshot.progress[0]!.phase).toBe('active');
});
