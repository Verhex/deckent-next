import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission } from '../support/custody.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-bound-dispatch-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'allow', custodyProfiles); stores.push(store);
  await admitRunAttempts(store, [identity]);
  const claim = { owner: 'fixture', request: { protocolVersion: 1 as const, identity, workspace: '/recorded/workspace', argv: ['recorded-tool'] } };
  return { store, path, claim };
}
it('reads only the exact bound stored request without requiring cancellation, preserving the cancellation gate', async () => {
  const { store, claim } = await fixture(); expect(await store.loadBoundDispatch(identity)).toBeNull();
  const admitted = await store.claimDispatch(dispatchAdmission(claim));
  expect(await store.loadBoundDispatch(identity)).toEqual(admitted.record);
  await expect(store.loadCancellationDispatch(identity)).rejects.toThrow('RUN_STORE_CONFLICT');
  await store.cancelRun({ commandId: 'cancel', actor: { id: 'user', issuer: 'host', subject: '1' }, scopeId: 's', runId: 'r', expectedRevision: 1 });
  expect(await store.loadCancellationDispatch(identity)).toEqual(await store.loadBoundDispatch(identity));
});
it('rejects every mismatched identity axis before returning a recorded workspace or argv', async () => {
  const { store, claim } = await fixture(); await store.claimDispatch(dispatchAdmission(claim));
  for (const changes of [{ scopeId: 'other' }, { runId: 'other' }, { taskId: 'other' }, { attemptId: 'other' }, { layoutRevision: 'other' }, { generation: 2 }]) {
    await expect(store.loadBoundDispatch({ ...identity, ...changes })).rejects.toThrow('RUN_STORE_CONFLICT');
  }
});
it('rejects a corrupt persisted dispatch binding', async () => {
  const { store, path, claim } = await fixture(); const admitted = await store.claimDispatch(dispatchAdmission(claim));
  const db = new DatabaseSync(path);
  try {
    db.prepare('UPDATE dispatches SET record=? WHERE scope_id=? AND attempt_id=?').run(JSON.stringify({ ...admitted.record, request: { ...claim.request, identity: { ...identity, generation: 2 } } }), 's', 'a');
    await expect(store.loadBoundDispatch(identity)).rejects.toThrow('RUN_STORE_CORRUPT');
  } finally { db.close(); }
});
