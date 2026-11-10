import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { bindCapacityResource, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { readCapacityResourceOccupancy } from '#adapters/core/sqlite-model-invocation/index.js';
import { RunReservationApplication } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { journalMode: 'wal', durability: 'full', busyTimeoutMs: 100 } as const;
const actor = { id: 'person', issuer: 'host', subject: 'owner' };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
const create = (scopeId: string) => ({ commandId: 'create', actor, identity: { scopeId, runId: 'run', layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph), now: 0,
  policy: { schemaVersion: 2 as const, poolId: 'pool', capacity: { executionSlots: 4, inFlightSlots: 4 }, ordering: ['a'] } });
const claim = (scopeId: string) => ({ commandId: 'claim', actor, scopeId, runId: 'run', expectedRevision: 0, now: 0,
  identities: [{ scopeId, runId: 'run', layoutRevision: 'layout', taskId: 'a', attemptId: 'attempt', generation: 1 }] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-resource-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 1000 }); stores.push(store);
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 4, inFlightSlots: 4 } });
  const db = openSqliteLedger(path, options, 'forbid');
  const resource = bindCapacityResource(db, { kind: 'fixture-login', id: 'same-login' }, { executionSlots: 1, inFlightSlots: 1 }); db.close();
  return { root, path, store, resource, bindings: [{ taskId: 'a', resourceKey: resource.resourceKey }] };
}
it('persists one opaque resource per connection locator across reopen; reconnect cannot change capacity', async () => {
  const f = await fixture(), db = openSqliteLedger(f.path, options, 'forbid');
  try {
    expect(f.resource.resourceKey).toMatch(/^[a-f0-9-]{36}$/u);
    expect(bindCapacityResource(db, { kind: 'fixture-login', id: 'same-login' }, { executionSlots: 1, inFlightSlots: 1 })).toEqual(f.resource);
    expect(() => bindCapacityResource(db, { kind: 'fixture-login', id: 'same-login' }, { executionSlots: 2, inFlightSlots: 2 })).toThrow('RUN_POOL_CONFLICT');
    expect(bindCapacityResource(db, { kind: 'fixture-login', id: 'separate-login' }, { executionSlots: 1, inFlightSlots: 1 }).resourceKey).not.toBe(f.resource.resourceKey);
  } finally { db.close(); }
});
it('reserves across two projects in one transaction and refuses a stale application snapshot with no partial attempt', async () => {
  const f = await fixture();
  for (const scope of ['one', 'two']) await f.store.createRun(create(scope), undefined, undefined, f.bindings);
  const other = await openSqliteAttemptStore(f.path, options, { now: Date.now, timeoutMs: 1000 }); stores.push(other);
  const stale = await other.loadRunResourceCapacity((await other.loadRun('two', 'run'))!);
  expect(stale.resources[0]?.occupancy).toEqual({ execution: 0, inFlight: 0 });
  const first = await f.store.reserveRunTasks(claim('one'));
  await expect(other.reserveRunTasks(claim('two'))).rejects.toMatchObject({ code: 'RUN_CAPACITY_OR_ORDER', diagnostic: { resourceWaitingCount: 1 } });
  expect(await other.load('two', 'attempt')).toBeNull(); expect((await other.loadRun('two', 'run'))!.revision).toBe(0);
  expect(await other.reserveRunTasks(claim('one'))).toEqual(first);
  const view = await other.loadRunResourceCapacity((await other.loadRun('two', 'run'))!);
  expect(view.resources[0]?.occupancy).toEqual({ execution: 1, inFlight: 1 });
  let generated = 0;
  const app = new RunReservationApplication(other, { async verify() { return { ...actor, assurance: 'os-user', scopeIds: ['two'] }; } },
    { async authorize() {} }, { async authorize() {} }, { now: () => 1, attemptId: () => String(++generated) });
  await expect(app.reserve({ schemaVersion: 1, scopeId: 'two', runId: 'run', commandId: 'application', expectedRevision: 0 })).rejects.toMatchObject({ code: 'RUN_CAPACITY_OR_ORDER', diagnostic: { reason: 'resource-capacity-exhausted' } });
  expect(generated).toBe(0);
});
it('cancels an unlaunched reservation through existing settlement and releases the resource without deleting its binding', async () => {
  const f = await fixture();
  for (const scope of ['one', 'two']) await f.store.createRun(create(scope), undefined, undefined, f.bindings);
  await f.store.reserveRunTasks(claim('one'));
  await f.store.cancelRun({ commandId: 'cancel', actor, scopeId: 'one', runId: 'run', expectedRevision: 1 });
  expect((await f.store.loadRunResourceCapacity((await f.store.loadRun('two', 'run'))!)).resources[0]?.occupancy).toEqual({ execution: 0, inFlight: 0 });
  await f.store.reserveRunTasks(claim('two'));
  const db = openSqliteLedger(f.path, options, 'forbid');
  try { expect(db.prepare('SELECT count(*) AS n FROM run_capacity_resources').get()?.n).toBe(2); } finally { db.close(); }
});
it('keeps custody on restart and elapsed time; a missing resource rolls back admission and a changed replay is refused', async () => {
  const f = await fixture(); await f.store.createRun(create('one'), undefined, undefined, f.bindings); await f.store.reserveRunTasks(claim('one'));
  const db = openSqliteLedger(f.path, options, 'forbid');
  try { expect(readCapacityResourceOccupancy(db, f.resource.resourceKey)).toEqual({ execution: 1, inFlight: 1 }); } finally { db.close(); }
  await expect(f.store.createRun(create('one'))).rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
  await expect(f.store.createRun(create('bad'), undefined, undefined, [{ taskId: 'a', resourceKey: randomUUID() }])).rejects.toMatchObject({ code: 'RUN_STORE_CORRUPT' });
  expect(await f.store.loadRun('bad', 'run')).toBeNull();
  const reopened = await openSqliteAttemptStore(f.path, options, { now: () => 1_000_000, timeoutMs: 1000 }); stores.push(reopened);
  await reopened.createRun(create('two'), undefined, undefined, f.bindings);
  await expect(reopened.reserveRunTasks({ ...claim('two'), now: 1_000_000 })).rejects.toMatchObject({ code: 'RUN_CAPACITY_OR_ORDER' });
  // KG10 F3: two bound tasks of one Run both count (the Run is decoded once per resource read).
  const pair = { ...graph, tasks: [graph.tasks[0]!, { ...graph.tasks[0]!, id: 'b' }] }, base = create('pair'), writer = openSqliteLedger(f.path, options, 'forbid');
  let pairKey: string; try { pairKey = bindCapacityResource(writer, { kind: 'fixture-login', id: 'pair-login' }, { executionSlots: 2, inFlightSlots: 2 }).resourceKey; } finally { writer.close(); }
  await reopened.createRun({ ...base, graph: pair, execution: fixtureExecution(pair), policy: { ...base.policy, ordering: ['a', 'b'] } }, undefined, undefined, ['a', 'b'].map(taskId => ({ taskId, resourceKey: pairKey })));
  await reopened.reserveRunTasks({ ...claim('pair'), now: 1_000_000, identities: ['a', 'b'].map(taskId => ({ ...claim('pair').identities[0]!, taskId, attemptId: taskId })) });
  const reader = openSqliteLedger(f.path, options, 'forbid');
  try { expect(readCapacityResourceOccupancy(reader, pairKey)).toEqual({ execution: 2, inFlight: 2 }); } finally { reader.close(); }
});

it('joins its caller transaction without committing a new legacy resource on rollback', async () => {
  const f = await fixture(), db = openSqliteLedger(f.path, options, 'forbid');
  try {
    db.exec('BEGIN IMMEDIATE');
    bindCapacityResource(db, { kind: 'fixture-login', id: 'legacy-login' }, { executionSlots: 1, inFlightSlots: 1 });
    expect(db.isTransaction).toBe(true);
    db.exec('ROLLBACK');
    expect(db.prepare("SELECT count(*) AS n FROM capacity_resources WHERE binding_id='legacy-login'").get()?.n).toBe(0);
  } finally { db.close(); }
});
