import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { RunAdmissionApplication, RunPolicyAuthorization } from '#engine/index.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const command = { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r',
  graph: { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'custom', dependencies: [], acceptanceCriteria: ['evidence'] }],
    criterionDefinitions: [{ id: 'evidence', version: 1, description: 'Verify evidence', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-admission-')); roots.push(root);
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }); stores.push(store);
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } });
  const state = { allow: true, subject: '1', contexts: 0, now: 10 };
  const verifier = { async verify() { return { id: 'user', issuer: 'host', subject: state.subject, assurance: 'os-user', scopeIds: ['s'] }; } };
  const authorization = new RunPolicyAuthorization({ async load() { return { schemaVersion: 1, revision: 'p', restrictions: [], grants: state.allow ? [
    { id: 'create', effect: 'allow', actions: ['create'], scopes: ['s'], principals: 'all', resource: { kind: 'run', ids: ['r'] } },
  ] : [] }; } });
  const context = { async resolve() { state.contexts++; return { layoutRevision: 'layout', now: state.now++, policy: { schemaVersion: 2 as const, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 2 }, ordering: ['t'] } }; } };
  const app = new RunAdmissionApplication(store, verifier, authorization, context);
  return { store, app, state, context, verifier, authorization };
}
it('admits only a task graph while trusted composition supplies clock, policy and layout; replay preserves the first result', async () => {
  const { app, store, state } = await fixture();
  for (const extra of [{ actor: { id: 'admin' } }, { now: 9999 }, { policy: { poolId: 'unlimited' } }, { layoutRevision: 'other' }]) {
    await expect(app.create({ ...command, ...extra })).rejects.toThrow();
  }
  expect(state.contexts).toBe(0); const result = await app.create(command);
  expect(result.run).toMatchObject({ runId: 'r', layoutRevision: 'layout', revision: 0 });
  expect((await store.loadRun('s', 'r'))!.progress[0]!.eligibleAt).toBe(10);
  state.now = 999; expect(await app.create(command)).toEqual(result); expect(state.contexts).toBe(1);
  expect((await store.loadRun('s', 'r'))!.bindings).toHaveLength(0);
});
it('enforces current create policy and actor/content identity before historical receipt replay', async () => {
  const { app, state, store } = await fixture(); state.allow = false;
  await expect(app.create(command)).rejects.toThrow('POLICY_DENIED'); expect(await store.loadRun('s', 'r')).toBeNull(); expect(state.contexts).toBe(0);
  state.allow = true; await app.create(command); state.allow = false;
  await expect(app.create(command)).rejects.toThrow('POLICY_DENIED'); state.allow = true; state.subject = 'other';
  await expect(app.create(command)).rejects.toThrow('RUN_COMMAND_CONFLICT'); state.subject = '1';
  await expect(app.create({ ...command, graph: { ...command.graph, revision: 2 } })).rejects.toThrow('RUN_COMMAND_CONFLICT');
  await expect(app.create({ ...command, scopeId: 'foreign' })).rejects.toThrow('AUTHENTICATION_SCOPE_DENIED');
});
it('concurrent identical admissions with different sampled clock values converge on one durable receipt', async () => {
  const { store, verifier, authorization, context } = await fixture();
  let arrivals = 0; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const app = new RunAdmissionApplication(store, verifier, authorization, { async resolve() {
    const resolved = await context.resolve(); if (++arrivals === 2) release(); await barrier; return resolved;
  } });
  const [first, second] = await Promise.all([app.create(command), app.create(command)]);
  expect(first).toEqual(second); expect((await store.loadRun('s', 'r'))!.revision).toBe(0);
});
