import { applyAttemptObservation } from '#domain/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = (id: string) => ({ runId: 'r', scopeId: 's', taskId: id, attemptId: id, layoutRevision: 'l', generation: 1 });
const claim = (id: string) => ({ owner: 'w', request: { protocolVersion: 1 as const, identity: identity(id), workspace: '/private', argv: ['tool'] } });
const actor = { id: 'user', issuer: 'host', subject: '1' };
const cancel = { commandId: 'cancel', actor, scopeId: 's', runId: 'r', expectedRevision: 1 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-cancel-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }); stores.push(store);
  await admitRunAttempts(store, ['a', 'b'].map(identity)); return { store, path };
}
it('atomically propagates intent to reserved and dispatched work, preserves active state and exact replay', async () => {
  const { store } = await fixture(); await store.claimDispatch(claim('a'));
  const receipt = await store.cancelRun(cancel);
  for (const id of ['a', 'b']) { expect((await store.load('s', id))!.cancelRequested).toBe(true); expect((await store.load('s', id))!.lastObservation).toBeNull(); }
  expect((await store.readDispatch(claim('a').request))!.cancellation).toEqual(actor);
  expect(receipt.snapshot.progress.every(p => p.phase === 'active')).toBe(true);
  expect(await store.cancelRun(cancel)).toEqual(receipt); expect((await store.load('s', 'a'))!.revision).toBe(1);
});
it('rolls the entire Run/Attempt/dispatch fanout back when a later binding is corrupt', async () => {
  const { store, path } = await fixture(); await store.claimDispatch(claim('a'));
  const db = new DatabaseSync(path);
  try {
    db.exec("UPDATE attempts SET revision=99 WHERE attempt_id='b'");
    await expect(store.cancelRun(cancel)).rejects.toThrow('RUN_STORE_CORRUPT');
    expect((await store.loadRun('s', 'r'))!.cancelRequested).toBe(false);
    expect((await store.load('s', 'a'))!.cancelRequested).toBe(false); expect((await store.readDispatch(claim('a').request))!.cancellation).toBeUndefined();
    db.exec("UPDATE attempts SET revision=0 WHERE attempt_id='b'"); expect((await store.cancelRun(cancel)).snapshot.cancelRequested).toBe(true);
  } finally { db.close(); }
});
it('preserves completed evidence and original per-attempt cancellation attribution', async () => {
  const { store } = await fixture(); await store.claimDispatch(claim('a')); await store.claimDispatch(claim('b'));
  await store.finishDispatch(claim('a'), { handle: 'h', exitCode: 0, interrupted: false }); const before = await store.load('s', 'a');
  const first = { id: 'first', issuer: 'host', subject: '2', assurance: 'os-user' as const, scopeIds: ['s'] };
  await store.requestDispatchCancellation(claim('b').request, first);
  await store.cancelRun({ ...cancel, expectedRevision: 2 });
  expect(await store.load('s', 'a')).toEqual(before);
  expect((await store.readDispatch(claim('b').request))!.cancellation!.id).toBe('first');
  expect((await store.load('s', 'b'))!.revision).toBe(1);
});

it('does not reattribute an already observed cancelled attempt', async () => {
  const { store } = await fixture(); await store.claimDispatch(claim('a'));
  const current = (await store.load('s', 'a'))!;
  const snapshot = applyAttemptObservation(current, { protocolVersion: 1, identity: identity('a'), sequence: 1, eventId: 'stopped', result: { kind: 'cancelled' } }, current.revision);
  await store.commit({ commandId: 'stopped', command: 'observed-stop', expectedRevision: current.revision, snapshot });
  await store.cancelRun(cancel);
  expect(await store.load('s', 'a')).toEqual(snapshot); expect((await store.readDispatch(claim('a').request))!.cancellation).toBeUndefined();
});
