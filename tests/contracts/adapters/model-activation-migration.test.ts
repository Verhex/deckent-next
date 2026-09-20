import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteModelActivationStore } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';

const options = Object.freeze({ busyTimeoutMs: 20, journalMode: 'delete' as const, durability: 'full' as const });

async function workspace(work: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-activation-migration-'));
  try { await work(join(root, 'ledger.db')); } finally { await rm(root, { recursive: true, force: true }); }
}
async function seedVersionTwelve(path: string) {
  const store = await openSqliteAttemptStore(path, options);
  try {
    await admitRunAttempts(store, [{ scopeId: 'scope-a', runId: 'run-a', taskId: 'task-a', attemptId: 'attempt-a', layoutRevision: 'layout-a', generation: 1 }]);
  } finally { store.close(); }
  const db = new DatabaseSync(path);
  try {
    db.exec(`DROP INDEX model_invocations_allocation_state;
      DROP TABLE model_invocation_contents; DROP TABLE model_invocations; DROP TABLE model_invocation_allocations;
      DROP TABLE model_activation_receipts; DROP TABLE model_activations; PRAGMA user_version=12`);
  } finally { db.close(); }
}
function executionEvidence(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.freeze({
      version: db.prepare('PRAGMA user_version').get()?.user_version,
      attempt: db.prepare('SELECT snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get('scope-a', 'attempt-a')?.snapshot,
      receipt: db.prepare('SELECT command,snapshot FROM run_receipts WHERE scope_id=? AND command_id=?').get('scope-a', 'create-run:run-a'),
      run: db.prepare('SELECT revision,snapshot,policy FROM runs WHERE scope_id=? AND run_id=?').get('scope-a', 'run-a'),
    });
  } finally { db.close(); }
}

it('migrates a genuine v12 execution ledger to v14 without changing existing run, receipt, attempt or policy payloads', async () => workspace(async path => {
  await seedVersionTwelve(path); const before = executionEvidence(path);
  expect(before.version).toBe(12);
  const activation = await openSqliteModelActivationStore(path, options, 'allow'); activation.close();
  const after = executionEvidence(path);
  expect(after).toEqual({ ...before, version: CURRENT_LEDGER_VERSION });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('model_activations','model_activation_receipts','model_invocation_allocations','model_invocations') ORDER BY name").all())
      .toEqual([{ name: 'model_activation_receipts' }, { name: 'model_activations' }, { name: 'model_invocation_allocations' },
        { name: 'model_invocations' }]);
  } finally { db.close(); }
}));

it('forbids v12 read-only activation opening without mutation, and rolls back partial schema14 DDL on a collision', async () => workspace(async path => {
  await seedVersionTwelve(path); const before = executionEvidence(path);
  await expect(openSqliteModelActivationStore(path, options, 'forbid')).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  expect(executionEvidence(path)).toEqual(before);

  const db = new DatabaseSync(path);
  try { db.exec('CREATE TABLE model_invocations(marker TEXT)'); } finally { db.close(); }
  await expect(openSqliteModelActivationStore(path, options, 'allow')).rejects.toThrow();
  const failed = new DatabaseSync(path, { readOnly: true });
  try {
    expect(failed.prepare('PRAGMA user_version').get()?.user_version).toBe(12);
    expect(failed.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='model_activations'").all()).toEqual([]);
    expect(failed.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='model_invocations'").get()?.sql).toContain('marker TEXT');
  } finally { failed.close(); }
  expect(executionEvidence(path)).toEqual(before);
}));
