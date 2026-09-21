import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { downgradeRunEligibilityFixtures } from '../support/legacy-run-eligibility.js';
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
it('refuses opening a schema2 reader, then reads only after the writer migrates to current schema', async () => {
  const path = await fixture(); const db = new DatabaseSync(path); db.exec('DROP TABLE provider_spend_audits; DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts; DROP TABLE model_invocation_allocation_checkpoints; DROP INDEX model_invocations_allocation_identity; DROP TABLE model_invocation_cancellations; DROP TABLE model_invocation_controls; DROP INDEX model_invocations_allocation_state; DROP TABLE model_invocation_contents; DROP TABLE model_invocation_content_purges; DROP TABLE model_invocations; DROP TABLE model_invocation_allocations; DROP TABLE model_activation_receipts; DROP TABLE model_activations; DROP TABLE installation_ownership; DROP TABLE service_shutdown_commands; DROP TABLE service_shutdown_outcomes; DROP TABLE cancellation_deliveries; DROP TABLE run_workspace_custody; DROP TABLE runs; DROP TABLE run_receipts; DROP TABLE execution_pools; DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=2'); db.close();
  const before = await readFile(path);
  await expect(openSqliteInventoryReader(path, { busyTimeoutMs: 20 })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  expect(await readFile(path)).toEqual(before);
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'delete', durability: 'full' });
  try { expect((await store.load('s', 'a'))!.identity.attemptId).toBe('a'); } finally { store.close(); }
  const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: 20 });
  try { expect(await reader.loadRun('s', 'r')).toBeNull(); } finally { reader.close(); }
  const migrated = new DatabaseSync(path, { readOnly: true });
  try { expect(migrated.prepare('PRAGMA user_version').get()!.user_version).toBe(CURRENT_LEDGER_VERSION); } finally { migrated.close(); }
});

it('requires migration before reading schema-eleven Run snapshots and leaves inspection bytes unchanged', async () => {
  const path = await fixture(), db = new DatabaseSync(path);
  downgradeRunEligibilityFixtures(db); db.exec('DROP TABLE provider_spend_audits; DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts; DROP TABLE model_invocation_allocation_checkpoints; DROP INDEX model_invocations_allocation_identity; DROP TABLE model_invocation_cancellations; DROP TABLE model_invocation_controls; DROP INDEX model_invocations_allocation_state; DROP TABLE model_invocation_contents; DROP TABLE model_invocation_content_purges; DROP TABLE model_invocations; DROP TABLE model_invocation_allocations; DROP TABLE model_activation_receipts; DROP TABLE model_activations; DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=11'); db.close();
  const before = await readFile(path), reader = await openSqliteInventoryReader(path, { busyTimeoutMs: 20 });
  try {
    await expect(reader.loadRun('s', 'r')).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
    await expect(reader.loadRunReceipt('s', 'create-run:r')).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
    expect((await reader.listDispatches({ schemaVersion: 1, scopeId: 's', after: null, limit: 1 })).entries).toEqual([]);
  } finally { reader.close(); }
  expect(await readFile(path)).toEqual(before);
  const writer = await openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'delete', durability: 'full' }); writer.close();
  const migrated = await openSqliteInventoryReader(path, { busyTimeoutMs: 20 });
  try { expect((await migrated.loadRun('s', 'r'))?.schemaVersion).toBe(3); }
  finally { migrated.close(); }
});
