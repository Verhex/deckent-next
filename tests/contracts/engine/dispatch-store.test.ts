import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { createAttempt } from '#domain/index.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const };
const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'l' };
const claim = { owner: 'owner-1', request: { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['node', 'task.js'] } };
const terminal = { handle: 'container', exitCode: 0, interrupted: false };
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-dispatch-')); roots.push(root);
  const path = join(root, 'ledger.db');
  const open = async () => { const store = await openSqliteAttemptStore(path, options); stores.push(store); return store; };
  return { path, open };
}
async function admit(store: SqliteAttemptStore) { await store.commit({ commandId: 'create', command: 'admission', expectedRevision: null, snapshot: createAttempt(identity) }); }
it('grants exactly one launch across connections, reopen and terminal recording', async () => {
  const f = await fixture(); const a = await f.open(); await admit(a); const b = await f.open();
  const results = await Promise.all([a.claimDispatch(claim), b.claimDispatch({ ...claim, owner: 'owner-2' })]);
  expect(results.map(x => x.acquired)).toEqual([true, false]);
  await expect(b.finishDispatch({ ...claim, owner: 'owner-2' }, terminal)).rejects.toThrow('DISPATCH_CONFLICT');
  expect((await a.claimDispatch(claim)).acquired).toBe(false);
  await a.finishDispatch(claim, terminal);
  const c = await f.open(); const replay = await c.claimDispatch(claim);
  expect(replay.acquired).toBe(false); expect(replay.record.terminal).toEqual(terminal);
  expect(await c.finishDispatch(claim, terminal)).toEqual(replay.record);
  await expect(c.finishDispatch(claim, { ...terminal, exitCode: 1 })).rejects.toThrow('DISPATCH_CONFLICT');
});
it('retains unresolved custody across restart and rejects request or generation substitution', async () => {
  const f = await fixture(); const a = await f.open(); await admit(a); await a.claimDispatch(claim);
  a.close(); stores.splice(stores.indexOf(a), 1);
  const b = await f.open(); expect((await b.claimDispatch(claim)).acquired).toBe(false);
  await expect(b.claimDispatch({ ...claim, request: { ...claim.request, argv: ['other'] } })).rejects.toThrow('DISPATCH_CONFLICT');
  await expect(b.claimDispatch({ ...claim, request: { ...claim.request, identity: { ...identity, generation: 2 } } })).rejects.toThrow('DISPATCH_CONFLICT');
});
it('refuses absent, cancelled and foreign-scope attempts before creating a dispatch', async () => {
  const f = await fixture(); const store = await f.open();
  await expect(store.claimDispatch(claim)).rejects.toThrow('DISPATCH_NOT_ADMITTED'); await admit(store);
  await expect(store.claimDispatch({ ...claim, request: { ...claim.request, identity: { ...identity, scopeId: 'foreign' } } })).rejects.toThrow('DISPATCH_NOT_ADMITTED');
  await store.commit({ commandId: 'cancel', command: 'cancel', expectedRevision: 0, snapshot: { ...createAttempt(identity), revision: 1, cancelRequested: true } });
  await expect(store.claimDispatch(claim)).rejects.toThrow('DISPATCH_NOT_ADMITTED');
  const db = new DatabaseSync(f.path); expect(db.prepare('SELECT count(*) AS n FROM dispatches').get()?.n).toBe(0); db.close();
});
it('upgrades Next schema1 atomically without losing existing attempt and receipt evidence', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.path);
  db.exec('CREATE TABLE attempts(scope_id TEXT,attempt_id TEXT,revision INTEGER,snapshot TEXT,PRIMARY KEY(scope_id,attempt_id)); CREATE TABLE attempt_receipts(scope_id TEXT,command_id TEXT,command TEXT,snapshot TEXT,PRIMARY KEY(scope_id,command_id)); PRAGMA user_version=1;');
  const snapshot = createAttempt(identity);
  db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run('s','a',0,JSON.stringify(snapshot));
  db.prepare('INSERT INTO attempt_receipts VALUES(?,?,?,?)').run('s','create','admission',JSON.stringify(snapshot)); db.close();
  const store = await f.open(); expect(await store.load('s','a')).toEqual(snapshot);
  expect((await store.receipt('s','create'))?.command).toBe('admission'); expect((await store.claimDispatch(claim)).acquired).toBe(true);
  const check = new DatabaseSync(f.path); expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(2); check.close();
});

it('atomically rolls back terminal projection with journal failure, then preserves cancellation intent on settlement', async () => {
  const f = await fixture(); const store = await f.open(); await admit(store); await store.claimDispatch(claim);
  await store.commit({ commandId: 'cancel-after-claim', command: 'cancel', expectedRevision: 0,
    snapshot: { ...createAttempt(identity), revision: 1, cancelRequested: true } });
  const db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE ON dispatches BEGIN SELECT RAISE(ABORT,'injected'); END;");
  await expect(store.finishDispatch(claim, terminal)).rejects.toThrow();
  expect((await store.load('s', 'a'))?.lastObservation).toBeNull();
  expect((await store.load('s', 'a'))?.revision).toBe(1);
  expect((await store.readDispatch(claim.request))?.terminal).toBeNull();
  db.exec('DROP TRIGGER fail_terminal'); db.close();
  await store.finishDispatch(claim, terminal);
  const settled = await store.load('s', 'a');
  expect(settled).toMatchObject({ revision: 2, cancelRequested: true, lastObservation: { sequence: 1, result: { kind: 'exited', exitCode: 0 } } });
  expect(settled).not.toHaveProperty('accepted');
  await store.finishDispatch(claim, terminal);
  expect(await store.load('s', 'a')).toEqual(settled);
});

it('rejects contradictory terminal causes without writing terminal evidence', async () => {
  const f = await fixture(); const store = await f.open(); await admit(store); await store.claimDispatch(claim);
  await expect(store.finishDispatch(claim, { ...terminal, exitCode: null })).rejects.toThrow();
  await expect(store.finishDispatch(claim, { ...terminal, signal: 'SIGTERM' })).rejects.toThrow();
  expect((await store.readDispatch(claim.request))?.terminal).toBeNull();
});

it('maps a competing terminal writer to dispatch conflict without altering either existing evidence', async () => {
  const f = await fixture(); const store = await f.open(); await admit(store); await store.claimDispatch(claim);
  const snapshot = { ...createAttempt(identity), revision: 1, lastObservation: { protocolVersion: 1 as const, identity,
    sequence: 1, eventId: 'other-terminal', result: { kind: 'exited' as const, exitCode: 9 } } };
  await store.commit({ commandId: 'other', command: 'other', expectedRevision: 0, snapshot });
  await expect(store.finishDispatch(claim, terminal)).rejects.toThrow('DISPATCH_CONFLICT');
  expect(await store.load('s', 'a')).toEqual(snapshot);
  expect((await store.readDispatch(claim.request))?.terminal).toBeNull();
});

it.each([true, false])('merges compatible recovery/execution evidence without a second Attempt transition (recoveryFirst=%s)', async recoveryFirst => {
  const f = await fixture(); const a = await f.open(); const b = await f.open(); await admit(a); await a.claimDispatch(claim);
  const unknown = { ...terminal, interrupted: null };
  await a.finishDispatch(claim, recoveryFirst ? unknown : terminal);
  const snapshot = await a.load('s', 'a');
  const merged = await b.finishDispatch(claim, recoveryFirst ? terminal : unknown);
  expect(merged.terminal).toEqual(terminal);
  expect(await b.load('s', 'a')).toEqual(snapshot);
  await expect(b.finishDispatch(claim, { ...terminal, interrupted: true })).rejects.toThrow('DISPATCH_CONFLICT');
  expect((await a.readDispatch(claim.request))?.terminal).toEqual(terminal);
});
