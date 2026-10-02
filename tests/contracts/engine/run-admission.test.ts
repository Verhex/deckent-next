import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { RunAdmissionApplication, RunPolicyAuthorization } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const command = { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r',
  graph: { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'custom', dependencies: [], acceptanceCriteria: ['evidence'] }],
    criterionDefinitions: [{ id: 'evidence', version: 1, description: 'Verify evidence', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-admission-')); roots.push(root);
  const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }); stores.push(store);
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } });
  const state = { allow: true, poolAllow: true, subject: '1', contexts: 0, now: 10, poolChecks: 0 };
  const verifier = { async verify() { return { id: 'user', issuer: 'host', subject: state.subject, assurance: 'os-user', scopeIds: ['s'] }; } };
  const authorization = new RunPolicyAuthorization({ async load() { return { schemaVersion: 1, revision: 'p', restrictions: [], grants: state.allow ? [
    { id: 'create', effect: 'allow', actions: ['create'], scopes: ['s'], principals: 'all', resource: { kind: 'run', ids: ['r'] } },
  ] : [] }; } });
  const poolAuthorization = { async authorize() { state.poolChecks++; if (!state.poolAllow) throw new Error('POLICY_DENIED'); } };
  const context = { async resolve() { state.contexts++; return { layoutRevision: 'layout', now: state.now++, execution: fixtureExecution(command.graph), policy: { schemaVersion: 2 as const, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 2 }, ordering: ['t'] } }; } };
  const app = new RunAdmissionApplication(store, verifier, authorization, poolAuthorization, context);
  return { store, app, state, context, verifier, authorization, poolAuthorization, path };
}
it('admits only a task graph while trusted composition supplies clock, policy and layout; replay preserves the first result', async () => {
  const { app, store, state } = await fixture();
  for (const extra of [{ actor: { id: 'admin' } }, { now: 9999 }, { policy: { poolId: 'unlimited' } }, { layoutRevision: 'other' }]) {
    await expect(app.create({ ...command, ...extra })).rejects.toThrow();
  }
  expect(state.contexts).toBe(0); const result = await app.create(command);
  expect(result.run).toMatchObject({ runId: 'r', layoutRevision: 'layout', revision: 0 });
  expect((await store.loadRun('s', 'r'))!.progress[0]!.eligibility).toEqual({ kind: 'immediate' });
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
it('requires pool use for a fresh admission without mutating a Run, but not for its receipt replay', async () => {
  const { app, store, state } = await fixture(); state.poolAllow = false;
  await expect(app.create(command)).rejects.toThrow('POLICY_DENIED'); expect(await store.loadRun('s', 'r')).toBeNull(); expect(state.poolChecks).toBe(1);
  state.poolAllow = true; const first = await app.create(command); expect(state.poolChecks).toBe(2);
  state.poolAllow = false; expect(await app.create(command)).toEqual(first); expect(state.poolChecks).toBe(2);
});
it('concurrent identical admissions with different sampled clock values converge on one durable receipt', async () => {
  const { store, verifier, authorization, poolAuthorization, context } = await fixture();
  let arrivals = 0; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const app = new RunAdmissionApplication(store, verifier, authorization, poolAuthorization, { async resolve() {
    const resolved = await context.resolve(); if (++arrivals === 2) release(); await barrier; return resolved;
  } });
  const [first, second] = await Promise.all([app.create(command), app.create(command)]);
  expect(first).toEqual(second); expect((await store.loadRun('s', 'r'))!.revision).toBe(0);
});
const pin = (baseRevision: string, runId = 'r') => ({ schemaVersion: 1 as const, scopeId: 's', runId, baseRevision,
  source: { schemaVersion: 1 as const, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'f'.repeat(64) } });
it('pins workspace custody in the admission transaction; replay needs the same custody and never re-pins', async () => {
  const { app, store } = await fixture();
  await expect(app.create(command, undefined, async () => pin('a'.repeat(40), 'other-run'))).rejects.toThrow('RUN_COMMAND_CONFLICT');
  expect(await store.loadRun('s', 'r')).toBeNull();
  const first = await app.create(command, undefined, async () => pin('a'.repeat(40)));
  expect(await store.loadRunWorkspaceCustody('s', 'r')).toEqual(pin('a'.repeat(40)));
  expect(await app.create(command, undefined, async () => pin('a'.repeat(40)))).toEqual(first);
  await expect(app.create(command, undefined, async () => pin('b'.repeat(40)))).rejects.toThrow('RUN_COMMAND_CONFLICT');
  expect(await store.loadRunWorkspaceCustody('s', 'r')).toEqual(pin('a'.repeat(40)));
  // The receipt command never carries the pin: record shapes are unchanged (ledger v41).
  expect(JSON.parse((await store.loadRunReceipt('s', 'create'))!.command)).not.toHaveProperty('workspace');
});
it('admits nothing when the pinned custody cannot be written: Run row, progression intent and custody commit together', async () => {
  const { app, store, path } = await fixture();
  // An orphan record (not producible through the store) makes the in-transaction custody write fail after the Run row insert.
  const db = new DatabaseSync(path);
  try { db.prepare('INSERT INTO run_workspace_custody(scope_id,run_id,record) VALUES(?,?,?)').run('s', 'r', JSON.stringify(pin('c'.repeat(40)))); } finally { db.close(); }
  const outcome = await app.create(command, undefined, async () => pin('a'.repeat(40))).then(() => 'admitted', (error: Error) => error.message);
  expect.soft(await store.loadRun('s', 'r')).toBeNull(); expect.soft(await store.loadRunReceipt('s', 'create')).toBeNull();
  const check = new DatabaseSync(path, { readOnly: true });
  try { expect.soft(check.prepare('SELECT count(*) AS n FROM run_execution_intents').get()).toEqual({ n: 0 }); } finally { check.close(); }
  expect(outcome).toBe('RUN_WORKSPACE_CUSTODY_CONFLICT');
});
