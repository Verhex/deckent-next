import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { RunReservationApplication, type ReservationRuntime } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' } as const;
const actor = { id: 'system-reserver', issuer: 'host', subject: '1000' };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [
  { id: 'a', kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] },
  { id: 'b', kind: 'selected', dependencies: ['a'], acceptanceCriteria: ['exit'] },
], criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
const command = { schemaVersion: 1 as const, commandId: 'reserve-wave', scopeId: 's', runId: 'r', expectedRevision: 0 };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-reservation-app-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, options); stores.push(store);
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  await store.createRun({ commandId: 'create', actor, identity: { scopeId: 's', runId: 'r', layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph), now: 0,
    policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['b', 'a'] } });
  const state = { allow: true, poolAllow: true, subject: actor.subject, reads: 0, generated: 0, authorizations: 0, poolAuthorizations: 0 };
  const verifier = { async verify() { return { ...actor, subject: state.subject, assurance: 'os-user', scopeIds: ['s'] }; } };
  const authorization = { async authorize() { state.authorizations++; if (!state.allow) throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' }); } };
  const poolAuthorization = { async authorize() { state.poolAuthorizations++; if (!state.poolAllow) throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' }); } };
  const runtime: ReservationRuntime = { now: () => 0, attemptId: () => `system-attempt-${++state.generated}` };
  const tracked = {
    async loadRun(...args: Parameters<typeof store.loadRun>) { state.reads++; return store.loadRun(...args); },
    async loadRunReceipt(...args: Parameters<typeof store.loadRunReceipt>) { state.reads++; return store.loadRunReceipt(...args); },
    async loadRunExecutionPolicy(...args: Parameters<typeof store.loadRunExecutionPolicy>) { state.reads++; return store.loadRunExecutionPolicy(...args); },
    async reserveRunTasks(...args: Parameters<typeof store.reserveRunTasks>) { state.reads++; return store.reserveRunTasks(...args); },
  };
  return { path, store, state, app: new RunReservationApplication(tracked, verifier, authorization, poolAuthorization, runtime), verifier, authorization, poolAuthorization };
}

it('selects only dependency-ready work within persisted capacity, using system-generated identities', async () => {
  const f = await fixture(); const reserved = await f.app.reserve(command);
  expect(reserved.identities).toEqual([{ scopeId: 's', runId: 'r', layoutRevision: 'layout', taskId: 'a', attemptId: 'system-attempt-1', generation: 1 }]);
  expect(reserved.run.revision).toBe(1); expect(f.state.generated).toBe(1);
  await expect(f.app.reserve({ ...command, commandId: 'no-ready', expectedRevision: 1 })).rejects.toMatchObject({ code: 'RUN_CAPACITY_OR_ORDER' });
});

it('replays the exact receipt without generating another ID, and rejects changed revision or authenticated actor', async () => {
  const f = await fixture(); const first = await f.app.reserve(command);
  expect(await f.app.reserve(command)).toEqual(first); expect(f.state.generated).toBe(1);
  await expect(f.app.reserve({ ...command, expectedRevision: 1 })).rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
  f.state.subject = 'different-subject';
  await expect(f.app.reserve(command)).rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
});

it('fails closed when a replay receipt carries a corrupt Run snapshot', async () => {
  const f = await fixture(); await f.app.reserve(command); const receipt = (await f.store.loadRunReceipt('s', command.commandId))!;
  const corrupt = new RunReservationApplication({
    loadRun: (...args) => f.store.loadRun(...args),
    loadRunReceipt: async () => ({ ...receipt, snapshot: { schemaVersion: 2 } }),
    loadRunExecutionPolicy: (...args) => f.store.loadRunExecutionPolicy(...args),
    reserveRunTasks: (...args) => f.store.reserveRunTasks(...args),
  }, f.verifier, f.authorization, f.poolAuthorization, { now: () => 0, attemptId: () => 'must-not-generate' });
  await expect(corrupt.reserve(command)).rejects.toMatchObject({ code: 'RUN_STORE_CORRUPT' });
});

it('rejects caller attempts, task selection, time, capacity, and identity injection before ledger access', async () => {
  const f = await fixture();
  for (const injected of [
    { tasks: ['a'] }, { identities: [{ taskId: 'a' }] }, { now: 7 }, { capacity: { executionSlots: 9 } }, { actor },
  ]) await expect(f.app.reserve(Object.assign({}, command, injected))).rejects.toThrow();
  expect(f.state.reads).toBe(0); expect(f.state.generated).toBe(0);
});

it('enforces fresh authorization before both reservation and replay', async () => {
  const f = await fixture(); f.state.allow = false;
  await expect(f.app.reserve(command)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.state.reads).toBe(0); expect(f.state.generated).toBe(0);
  f.state.allow = true; const receipt = await f.app.reserve(command); const reads = f.state.reads;
  f.state.allow = false; await expect(f.app.reserve(command)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.state.reads).toBe(reads); expect(f.state.generated).toBe(1); expect(receipt.identities[0]!.attemptId).toBe('system-attempt-1');
});

it('requires current pool authority only for a fresh capacity mutation', async () => {
  const f = await fixture(); f.state.poolAllow = false;
  await expect(f.app.reserve(command)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect((await f.store.loadRun('s', 'r'))!.revision).toBe(0); expect(f.state.poolAuthorizations).toBe(1);
  f.state.poolAllow = true; const receipt = await f.app.reserve(command); expect(f.state.poolAuthorizations).toBe(2);
  f.state.poolAllow = false; expect(await f.app.reserve(command)).toEqual(receipt); expect(f.state.poolAuthorizations).toBe(2);
});

it('returns the winning generated identity to concurrent identical commands', async () => {
  const f = await fixture(); const second = await openSqliteAttemptStore(f.path, options); stores.push(second);
  let generated = 0;
  const app = new RunReservationApplication(second, f.verifier, f.authorization, f.poolAuthorization, { now: () => 0, attemptId: () => `other-attempt-${++generated}` });
  const results = await Promise.all([f.app.reserve(command), app.reserve(command)]);
  expect(results[0].identities).toEqual(results[1].identities);
  expect(results[0].identities).toHaveLength(1); expect((await second.loadRun('s', 'r'))!.revision).toBe(1);
});
