import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteInventoryReader } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-reader-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'delete', durability: 'full' });
  try { await admitRunAttempts(store, [{ runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 }]); }
  finally { store.close(); } return path;
}
it('reads an existing Run without mutating the ledger and never crosses scope', async () => {
  const path = await fixture(); const before = await readFile(path); const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: 20 });
  try {
    expect((await reader.loadRun('s', 'r'))!.progress[0]!.phase).toBe('active');
    expect(await reader.loadRun('foreign', 'r')).toBeNull(); expect(await reader.loadRun('s', 'missing')).toBeNull();
  } finally { reader.close(); }
  expect(await readFile(path)).toEqual(before);
});
it('rejects column/snapshot revision divergence in both read-only and writable readers', async () => {
  const path = await fixture(); const db = new DatabaseSync(path); db.exec('UPDATE runs SET revision=99'); db.close();
  const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: 20 });
  const writer = await openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'delete', durability: 'full' });
  try {
    await expect(reader.loadRun('s', 'r')).rejects.toMatchObject({ code: 'RUN_STORE_CORRUPT' });
    await expect(writer.loadRun('s', 'r')).rejects.toMatchObject({ code: 'RUN_STORE_CORRUPT' });
  } finally { reader.close(); writer.close(); }
});
it('refuses Run queries on schema2 instead of creating tables or upgrading the ledger', async () => {
  const path = await fixture(); const db = new DatabaseSync(path); db.exec('DROP TABLE runs; DROP TABLE run_receipts; DROP TABLE execution_pools; PRAGMA user_version=2'); db.close();
  const before = await readFile(path); const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: 20 });
  try { await expect(reader.loadRun('s', 'r')).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' }); } finally { reader.close(); }
  expect(await readFile(path)).toEqual(before);
});
