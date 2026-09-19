import { downgradeRunEligibilityFixtures } from '../support/legacy-run-eligibility.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { applyAttemptObservation } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = { id: 'service', issuer: 'host', subject: '1000' };
const options = { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' } as const;
const pool = { schemaVersion: 1 as const, poolId: 'shared', capacity: { executionSlots: 1, inFlightSlots: 2 } };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify task result', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const id = (scopeId: string) => ({ scopeId, runId: 'run', layoutRevision: 'layout', taskId: 'a', attemptId: 'same-local-id', generation: 1 });
const create = (scopeId: string) => ({ commandId: 'create', actor, identity: { scopeId, runId: 'run', layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph), now: 0,
  policy: { schemaVersion: 2 as const, poolId: 'shared', capacity: { executionSlots: 10, inFlightSlots: 10 }, ordering: ['a'] } });
const claim = (scopeId: string) => ({ commandId: 'claim', actor, scopeId, runId: 'run', now: 0, expectedRevision: 0, identities: [id(scopeId)] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-pool-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, options); stores.push(store); return { path, store };
}
async function project(store: SqliteAttemptStore, scopeId: string, unknown = false) {
  const identity = id(scopeId); const current = (await store.load(scopeId, identity.attemptId))!;
  const snapshot = applyAttemptObservation(current, { protocolVersion: 1, identity, sequence: 1, eventId: 'observed',
    result: unknown ? { kind: 'unknown', reasonCode: 'disconnected' } : { kind: 'exited', exitCode: 0 } }, 0);
  await store.commit({ commandId: 'observed', command: 'observed', expectedRevision: 0, snapshot });
  return store.projectRunAttempt({ commandId: 'project', actor, scopeId, runId: 'run', expectedRevision: 1, attemptId: identity.attemptId });
}
it('requires explicit immutable pool provisioning and leaves no Run on missing pool', async () => {
  const { store } = await fixture(); await expect(store.createRun(create('s'))).rejects.toThrow('RUN_POOL_REQUIRED');
  expect(await store.loadRun('s', 'run')).toBeNull(); expect(await store.createExecutionPool(pool)).toEqual(pool);
  expect(await store.createExecutionPool(pool)).toEqual(pool);
  await expect(store.createExecutionPool({ ...pool, capacity: { executionSlots: 2, inFlightSlots: 2 } })).rejects.toThrow('RUN_POOL_CONFLICT');
});
it('bounds different Runs/scopes across connections and retains evaluation pressure without a second counter', async () => {
  const { store, path } = await fixture(); await store.createExecutionPool(pool);
  for (const scope of ['one', 'two', 'three']) await store.createRun(create(scope));
  const second = await openSqliteAttemptStore(path, options); stores.push(second);
  const claims = await Promise.allSettled([store.reserveRunTasks(claim('one')), second.reserveRunTasks(claim('two'))]);
  expect(claims[0].status).toBe('fulfilled'); expect(claims[1]).toMatchObject({ status: 'rejected', reason: { code: 'RUN_POOL_FULL' } });
  expect(await second.load('two', id('two').attemptId)).toBeNull(); expect((await second.loadRun('two', 'run'))!.revision).toBe(0);
  await project(store, 'one'); await second.reserveRunTasks(claim('two')); await project(second, 'two');
  await expect(store.reserveRunTasks(claim('three'))).rejects.toThrow('RUN_POOL_FULL');
  expect((await store.reserveRunTasks(claim('one'))).snapshot.revision).toBe(1); // historical replay consumes no new slot
  expect((await store.loadRun('one', 'run'))!.progress[0]!.phase).toBe('evaluating');
});
it('does not free uncertain capacity because time passes or a connection reopens', async () => {
  const { store, path } = await fixture(); await store.createExecutionPool(pool);
  await store.createRun(create('one')); await store.createRun(create('two')); await store.reserveRunTasks(claim('one')); await project(store, 'one', true);
  const reopened = await openSqliteAttemptStore(path, options); stores.push(reopened);
  await expect(reopened.reserveRunTasks({ ...claim('two'), now: 1_000_000_000 })).rejects.toThrow('RUN_POOL_FULL');
});
it('rejects schema-3 policy without pool evidence and preserves the complete old ledger', async () => {
  const { store, path } = await fixture(); await store.createExecutionPool(pool); await store.createRun(create('s')); await store.reserveRunTasks(claim('s'));
  store.close(); stores.splice(stores.indexOf(store), 1);
  const db = new DatabaseSync(path); downgradeRunEligibilityFixtures(db); db.prepare('UPDATE runs SET policy=?').run(JSON.stringify({ schemaVersion: 1, capacity: pool.capacity, ordering: ['a'] }));
  db.exec('DROP TABLE installation_ownership; DROP TABLE service_shutdown_commands; DROP TABLE service_shutdown_outcomes; DROP TABLE run_workspace_custody; DROP TABLE cancellation_deliveries; DROP TABLE execution_pools; PRAGMA user_version=3;'); db.close();
  const before = await readFile(path);
  await expect(openSqliteAttemptStore(path, options)).rejects.toMatchObject({ code: 'LEDGER_MIGRATION_EVIDENCE_REQUIRED' });
  expect(await readFile(path)).toEqual(before);
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    expect(JSON.parse(String(check.prepare('SELECT snapshot FROM runs').get()?.snapshot)).schemaVersion).toBe(2);
    expect(check.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='execution_pools'").get()?.count).toBe(0);
    expect(check.prepare('SELECT count(*) AS count FROM attempts').get()?.count).toBe(1);
  } finally { check.close(); }
});
