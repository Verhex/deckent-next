import { DOWNGRADE_TO_V51_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteApprovalStore, openSqliteAttemptStore } from '#adapters/index.js';
import { openSqliteLedger, CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { requestTaskApproval, verifyApproval } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
/** Real pre-run-create approval CHECK and indexes. The other v51 tables are unchanged by v52. */
const toV51 = DOWNGRADE_TO_V51_LEDGER_SQL;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-migration-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 1000 });
  const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 'task', kind: 'custom', dependencies: [], acceptanceCriteria: ['proof'] }],
    criterionDefinitions: [{ id: 'proof', version: 1, description: 'Business criterion', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  const actor = { id: 'owner', issuer: 'local-test', subject: 'owner' };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  await store.createRun({ commandId: 'old-create', identity: { runId: 'old-run', scopeId: 's', layoutRevision: 'layout' }, actor, graph, execution: fixtureExecution(graph), now: 10,
    policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['task'] } }); store.close();
  const integrity = createHmacIntegrity('key', randomBytes(32)), journal = openSqliteApprovalStore(path, options);
  const task = requestTaskApproval(journal.store, integrity, { scopeId: 's', runId: 'old-run', taskId: 'task', requester: actor,
    actionDigest: 'a'.repeat(64), policyRevision: 'p1', summary: 'Historical approval', createdAt: 10, expiresAt: 1000 }); journal.close();
  const db = new DatabaseSync(path); db.exec(toV51); db.close(); return { path, integrity, task };
}
it('v51 refuses the new subject and forbid admission; v52 preserves every old sealed snapshot and Run receipt byte', async () => {
  const f = await fixture(), before = new DatabaseSync(f.path);
  const oldRun = before.prepare('SELECT snapshot FROM runs').get()!.snapshot, receipt = before.prepare('SELECT command,snapshot FROM run_receipts').get()!;
  expect(() => before.prepare('INSERT INTO approvals(scope_id,approval_id,subject_kind,action_digest,revision,snapshot) VALUES(?,?,?,?,?,?)')
    .run('s', 'new', 'run-create', 'b'.repeat(64), 0, '{}')).toThrow(/CHECK/); before.close();
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgraded = openSqliteLedger(f.path, options, 'allow');
  expect(CURRENT_LEDGER_VERSION).toBe(66); expect(upgraded.prepare('PRAGMA user_version').get()!.user_version).toBe(66);
  expect(upgraded.prepare('SELECT snapshot FROM runs').get()!.snapshot).toBe(oldRun);
  expect(upgraded.prepare('SELECT command,snapshot FROM run_receipts').get()).toEqual(receipt);
  expect(JSON.parse(String(oldRun))).not.toHaveProperty('authority'); expect(upgraded.prepare('SELECT count(*) AS n FROM audit_events').get()!.n).toBe(0); upgraded.close();
  const journal = openSqliteApprovalStore(f.path, options);
  try { expect(verifyApproval(journal.store.load('s', f.task.request.approvalId)!, f.integrity)).toEqual(f.task); } finally { journal.close(); }
});
it('a failed v52 migration rolls back the version and all existing approval rows', async () => {
  const f = await fixture(), db = new DatabaseSync(f.path);
  const before = db.prepare('SELECT * FROM approvals').all(); db.exec('CREATE TABLE approvals_v52(conflict TEXT)'); db.close();
  expect(() => openSqliteLedger(f.path, options, 'allow')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const check = new DatabaseSync(f.path);
  try { expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(51); expect(check.prepare('SELECT * FROM approvals').all()).toEqual(before); }
  finally { check.close(); }
});
