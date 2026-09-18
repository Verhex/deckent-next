import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';

const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-policy-read-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }); stores.push(store);
  await admitRunAttempts(store, [{ scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 }]);
  return { path, store };
}

it('returns the persisted policy without mutating the Run', async () => {
  const { store } = await fixture(); const before = await store.loadRun('s', 'r');
  const policy = await store.loadRunExecutionPolicy('s', 'r');
  expect(policy).toEqual({ schemaVersion: 2, poolId: 'fixture-pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] });
  expect(await store.loadRun('s', 'r')).toEqual(before);
});

it('rejects missing, foreign-scope and malformed identities without fallback', async () => {
  const { store } = await fixture();
  await expect(store.loadRunExecutionPolicy('s', 'missing')).rejects.toThrow('RUN_STORE_CONFLICT');
  await expect(store.loadRunExecutionPolicy('foreign', 'r')).rejects.toThrow('RUN_STORE_CONFLICT');
  await expect(store.loadRunExecutionPolicy('', 'r')).rejects.toThrow();
});

it.each(['revision', 'snapshot', 'execution', 'policy'] as const)('fails closed for corrupt persisted %s', async kind => {
  const { path, store } = await fixture(); const db = new DatabaseSync(path);
  try {
    if (kind === 'revision') db.exec("UPDATE runs SET revision=99 WHERE scope_id='s' AND run_id='r'");
    if (kind === 'snapshot') db.exec("UPDATE runs SET snapshot='not-json' WHERE scope_id='s' AND run_id='r'");
    if (kind === 'execution') {
      const row = db.prepare("SELECT snapshot FROM runs WHERE scope_id='s' AND run_id='r'").get()!; const snapshot = JSON.parse(String(row.snapshot));
      snapshot.execution.criteria[0].fingerprint = '0'.repeat(64); db.prepare("UPDATE runs SET snapshot=? WHERE scope_id='s' AND run_id='r'").run(JSON.stringify(snapshot));
    }
    if (kind === 'policy') db.exec("UPDATE runs SET policy='{}' WHERE scope_id='s' AND run_id='r'");
  } finally { db.close(); }
  await expect(store.loadRunExecutionPolicy('s', 'r')).rejects.toThrow('RUN_STORE_CORRUPT');
});
