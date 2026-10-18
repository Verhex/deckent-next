import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteLedger, openSqliteLedgerAnchor } from '#adapters/index.js';
import { createAttempt } from '#domain/index.js';

// R6: the runtime service's lifetime connection. While it is open no client's close is SQLite's last one, so -wal/-shm are neither
// unlinked nor recreated under concurrent client opens; it holds no lock or snapshot, so writers and checkpoints are never held back.
const roots: string[] = []; const closers: (() => void)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 40, journalMode: 'wal', durability: 'full' } as const;
const present = async (path: string) => lstat(path).then(stat => stat.ino, () => null);
async function ledger() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-anchor-')); roots.push(root); const path = join(root, 'ledger.db');
  (await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86400000 })).close();
  return path;
}
const command = (attemptId: string) => ({ commandId: `create-${attemptId}`, command: 'create' as const, expectedRevision: null,
  snapshot: createAttempt({ runId: 'r', taskId: 't', attemptId, scopeId: 's', generation: 1, layoutRevision: 'v' }) });
async function clientWrite(path: string, attemptId: string) {
  const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86400000 });
  try { await store.commit(command(attemptId)); } finally { store.close(); }
}

it.skipIf(process.platform === 'win32')('without an anchor the last client close unlinks -wal/-shm; with one they stay the same files across client opens', async () => {
  const path = await ledger();
  await clientWrite(path, 'a');
  expect([await present(`${path}-wal`), await present(`${path}-shm`)]).toEqual([null, null]);
  const anchor = openSqliteLedgerAnchor(path, options); closers.push(() => anchor.close());
  const shm = await present(`${path}-shm`); expect(shm).not.toBeNull();
  await clientWrite(path, 'b'); await clientWrite(path, 'c');
  expect(await present(`${path}-shm`)).toBe(shm); expect(await present(`${path}-wal`)).not.toBeNull();
});

it.skipIf(process.platform === 'win32')('the anchor holds no write lock and no snapshot: a write commits and a truncating checkpoint completes beside it', async () => {
  const path = await ledger();
  const anchor = openSqliteLedgerAnchor(path, options); closers.push(() => anchor.close());
  await clientWrite(path, 'a');
  const writer = openSqliteLedger(path, options, 'forbid'); closers.push(() => writer.close());
  expect(writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()).toMatchObject({ busy: 0 });
  expect((await lstat(`${path}-wal`)).size).toBe(0);
  // Read-only: the anchor itself can never write the ledger.
  expect(() => anchor.exec('CREATE TABLE anchor_write(x)')).toThrow();
});
