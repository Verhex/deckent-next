import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
const options = { busyTimeoutMs: 100, journalMode: 'wal' as const, durability: 'full' as const };
const limits = { maxAttempts: 2, retryDelayMs: 5, claimTtlMs: 10 };
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(terminalAttemptId?: string) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-cancel-recovery-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, options, 'allow', custodyProfiles); stores.push(store);
  const identities = ['a', 'b', 'c'].map(attemptId => ({ scopeId: 's', runId: 'r', taskId: attemptId, attemptId, generation: 1, layoutRevision: 'l' }));
  await admitRunAttempts(store, identities);
  for (const identity of identities) await store.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: '/w', argv: ['tool'] } }));
  if (terminalAttemptId) {
    const identity = identities.find(value => value.attemptId === terminalAttemptId)!;
    const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity, workspace: '/w', argv: ['tool'] } };
    await grantTestLaunch(store, claim); await store.finishDispatch(claim, { handle: 'worker-handle', exitCode: 0, interrupted: false });
  }
  const revision = (await store.loadRun('s', 'r'))!.revision;
  await store.cancelRun({ commandId: 'cancel', actor: { id: 'operator', issuer: 'test', subject: 'fixture' }, scopeId: 's', runId: 'r', expectedRevision: revision });
  return { path, store, identities };
}
const query = (afterAttemptId: string | null, limit: number, now = 1) => ({ scopeId: 's', afterAttemptId, limit, now });

it('discovers durable cancellations after restart and advances by the last scanned row', async () => {
  const f = await fixture(); f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = await openSqliteAttemptStore(f.path, options, 'allow', custodyProfiles); stores.push(reopened);
  const first = await reopened.discoverCancellationRecovery(query(null, 2));
  expect(first).toEqual({ identities: f.identities.slice(0, 2), nextAfterAttemptId: 'b' });
  expect(await reopened.discoverCancellationRecovery(query(first.nextAfterAttemptId, 2))).toEqual({ identities: [f.identities[2]], nextAfterAttemptId: 'c' });
  expect(await reopened.discoverCancellationRecovery(query('c', 2))).toEqual({ identities: [], nextAfterAttemptId: null });
  await expect(reopened.discoverCancellationRecovery({ ...query(null, 2), scopeId: 'other' })).resolves.toEqual({ identities: [], nextAfterAttemptId: null });
});

it('uses retry deadlines and scans noneligible rows without skipping or hanging', async () => {
  const f = await fixture();
  await f.store.claimCancellationDelivery({ identity: f.identities[0]!, token: 'active', now: 1, limits });
  await f.store.claimCancellationDelivery({ identity: f.identities[1]!, token: 'queued', now: 1, limits });
  await f.store.finishCancellationDelivery({ identity: f.identities[1]!, token: 'queued', now: 2, limits, outcome: 'unresolved' });
  const page = await f.store.discoverCancellationRecovery(query(null, 2, 4));
  expect(page).toEqual({ identities: [], nextAfterAttemptId: 'b' });
  expect(await f.store.discoverCancellationRecovery(query(null, 2, 7))).toEqual({ identities: [f.identities[1]], nextAfterAttemptId: 'b' });
  expect(await f.store.discoverCancellationRecovery(query(null, 2, 11))).toEqual({ identities: [f.identities[0], f.identities[1]], nextAfterAttemptId: 'b' });
});

it('excludes terminal and prevented dispatches plus terminal, prevented and exhausted journals', async () => {
  const f = await fixture('b');
  const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity: f.identities[0]!, workspace: '/w', argv: ['tool'] } };
  expect(await grantTestLaunch(f.store, claim)).toMatchObject({ kind: 'prevented' });
  await f.store.claimCancellationDelivery({ identity: f.identities[2]!, token: 'terminal', now: 1, limits });
  await f.store.finishCancellationDelivery({ identity: f.identities[2]!, token: 'terminal', now: 2, limits, outcome: 'terminal' });
  expect(await f.store.discoverCancellationRecovery(query(null, 3, 100))).toEqual({ identities: [], nextAfterAttemptId: 'c' });
  const fresh = await fixture();
  await fresh.store.claimCancellationDelivery({ identity: fresh.identities[0]!, token: 'prevented', now: 1, limits });
  await fresh.store.finishCancellationDelivery({ identity: fresh.identities[0]!, token: 'prevented', now: 2, limits, outcome: 'prevented' });
  await fresh.store.claimCancellationDelivery({ identity: fresh.identities[1]!, token: 'one', now: 1, limits });
  await fresh.store.finishCancellationDelivery({ identity: fresh.identities[1]!, token: 'one', now: 2, limits, outcome: 'unresolved' });
  await fresh.store.claimCancellationDelivery({ identity: fresh.identities[1]!, token: 'two', now: 7, limits });
  await fresh.store.finishCancellationDelivery({ identity: fresh.identities[1]!, token: 'two', now: 8, limits, outcome: 'unresolved' });
  expect(await fresh.store.discoverCancellationRecovery(query(null, 3, 100))).toEqual({ identities: [fresh.identities[2]], nextAfterAttemptId: 'c' });
});

it.each(['dispatch-identity', 'attempt-identity', 'journal-identity'] as const)('fails closed for corrupt persisted %s', async kind => {
  const f = await fixture();
  if (kind === 'journal-identity') await f.store.claimCancellationDelivery({ identity: f.identities[0]!, token: 'active', now: 1, limits });
  const db = new DatabaseSync(f.path);
  try {
    const table = kind === 'journal-identity' ? 'cancellation_deliveries' : kind === 'dispatch-identity' ? 'dispatches' : 'attempts';
    const column = table === 'attempts' ? 'snapshot' : 'record';
    const row = db.prepare(`SELECT ${column} FROM ${table} WHERE scope_id='s' AND attempt_id='a'`).get()!;
    const value = JSON.parse(String(row[column]));
    if (table === 'dispatches') value.request.identity.runId = 'foreign'; else value.identity.runId = 'foreign';
    db.prepare(`UPDATE ${table} SET ${column}=? WHERE scope_id='s' AND attempt_id='a'`).run(JSON.stringify(value));
  } finally { db.close(); }
  await expect(f.store.discoverCancellationRecovery(query(null, 1))).rejects.toMatchObject({ code: 'CANCELLATION_DELIVERY_CORRUPT' });
});

it('rejects a persisted Attempt revision mismatch before exposing recovery candidates', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.path);
  try { db.exec("UPDATE attempts SET revision=revision+1 WHERE scope_id='s' AND attempt_id='a'"); } finally { db.close(); }
  await expect(f.store.discoverCancellationRecovery(query(null, 1))).rejects.toMatchObject({ code: 'CANCELLATION_DELIVERY_CORRUPT' });
});
