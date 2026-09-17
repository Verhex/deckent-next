import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { RunApplication, RunPolicyAuthorization } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 };
const command = { schemaVersion: 1, action: 'cancel', commandId: 'cancel', scopeId: 's', runId: 'r', expectedRevision: 1 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-app-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }); stores.push(store);
  await admitRunAttempts(store, [identity]);
  const state = { allow: true, authenticated: true, subject: '1000', accesses: 0 };
  const verifier = { async verify() { if (!state.authenticated) throw new Error('no session'); return { id: 'user', issuer: 'host', subject: state.subject, assurance: 'os-user', scopeIds: ['s'] }; } };
  const authorization = new RunPolicyAuthorization({ async load() { return { schemaVersion: 1, revision: 'p', restrictions: [], grants: state.allow ? [
    { id: 'run', effect: 'allow', actions: ['cancel', 'inspect'], scopes: ['s'], principals: 'all', resource: { kind: 'run', ids: ['r'] } },
  ] : [] }; } });
  const app = new RunApplication({ async loadRun(scope, run) { state.accesses++; return store.loadRun(scope, run); },
    async cancelRun(input) { state.accesses++; return store.cancelRun(input); } }, verifier, authorization);
  return { store, app, state, path };
}
it('persists cancellation intent, blocks fresh dispatch and reservations without fabricating worker termination', async () => {
  const { store, app, path } = await fixture();
  const receipt = await app.execute(command); expect(receipt.snapshot.cancelRequested).toBe(true); expect(receipt.snapshot.revision).toBe(2);
  expect(receipt.snapshot.progress[0]!.phase).toBe('active'); expect((await store.load('s', 'a'))!.cancelRequested).toBe(false);
  await expect(store.claimDispatch({ owner: 'w', request: { protocolVersion: 1, identity, workspace: '/workspace', argv: ['true'] } })).rejects.toThrow('DISPATCH_NOT_ADMITTED');
  await expect(store.reserveRunTasks({ commandId: 'late', actor: { id: 'user', issuer: 'host', subject: '1000' }, scopeId: 's', runId: 'r', now: 0, expectedRevision: 2, identities: [{ ...identity, attemptId: 'b' }] })).rejects.toThrow();
  expect(await app.execute(command)).toEqual(receipt);
  const reopened = await openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }); stores.push(reopened);
  expect((await reopened.loadRun('s', 'r'))!.cancelRequested).toBe(true);
  expect((await app.inspect({ schemaVersion: 1, scopeId: 's', runId: 'r' }))!.revision).toBe(2);
});
it('authenticates and checks current policy before any read, write or replay', async () => {
  const { app, state } = await fixture();
  state.authenticated = false; await expect(app.execute(command)).rejects.toThrow('AUTHENTICATION_REQUIRED');
  state.authenticated = true; await expect(app.execute({ ...command, scopeId: 'foreign' })).rejects.toThrow('AUTHENTICATION_SCOPE_DENIED');
  state.allow = false; await expect(app.execute(command)).rejects.toThrow('POLICY_DENIED');
  await expect(app.inspect({ schemaVersion: 1, scopeId: 's', runId: 'r' })).rejects.toThrow('POLICY_DENIED'); expect(state.accesses).toBe(0);
  state.allow = true; await app.execute(command); expect(state.accesses).toBe(1);
  state.allow = false; await expect(app.execute(command)).rejects.toThrow('POLICY_DENIED'); expect(state.accesses).toBe(1);
});
it('rejects caller identity injection, changed actors and stale revisions', async () => {
  const { app, state, store } = await fixture();
  await expect(app.execute({ ...command, actor: { id: 'admin' } })).rejects.toThrow(); expect(state.accesses).toBe(0);
  await expect(app.execute({ ...command, expectedRevision: 0 })).rejects.toThrow('RUN_STORE_CONFLICT');
  expect((await store.loadRun('s', 'r'))!.cancelRequested).toBe(false);
  await app.execute(command); state.subject = 'other'; await expect(app.execute(command)).rejects.toThrow('RUN_COMMAND_CONFLICT');
  expect((await store.loadRun('s', 'r'))!.revision).toBe(2);
});
it('rolls cancellation state back if its durable command receipt cannot be written', async () => {
  const { app, store, path } = await fixture(); const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TRIGGER reject_cancel BEFORE INSERT ON run_receipts WHEN NEW.command_id='cancel' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    await expect(app.execute(command)).rejects.toThrow();
    expect((await store.loadRun('s', 'r'))!.cancelRequested).toBe(false); expect((await store.loadRun('s', 'r'))!.revision).toBe(1);
    db.exec('DROP TRIGGER reject_cancel'); expect((await app.execute(command)).snapshot.cancelRequested).toBe(true);
  } finally { db.close(); }
});
