import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger, CURRENT_LEDGER_VERSION, ENVIRONMENT_READINESS_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { DOWNGRADE_TO_V58_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { applyAttemptObservation, attemptSnapshotSchema, createAttempt, createRun, observeRunAttemptClosure, reserveRunTasks, runSnapshotSchema } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
// PRE-7: the environment park widens stored contracts (Run park reason, previous-binding kind, launch-refused `requirement`, report evidence
// `not-run`, task reason `acceptance-check-not-run`). One additive ledger step (v59): every v58 record parses under them unchanged, nothing is
// rewritten, and the version keeps an older build from reading a ledger that may hold the new vocabulary.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const identity = { runId: 'r', taskId: 'task', attemptId: 'a1', scopeId: 's', generation: 1, layoutRevision: 'layout' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dn-environment-v59-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups);
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path);
  const graph = { schemaVersion: 4, revision: 1, tasks: [{ id: 'task', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  // The v58 shape a live ledger holds: a Run whose pre-launch refusal (alpha.49 vocabulary) failed its task, and that attempt.
  const attempt = applyAttemptObservation(createAttempt(identity), { protocolVersion: 1, identity, sequence: 1, eventId: 'e1', result: { kind: 'launch-refused', code: 'EXECUTION_NOT_CONFIGURED' } }, 0);
  const run = observeRunAttemptClosure(reserveRunTasks(createRun({ scopeId: 's', runId: 'r', layoutRevision: 'layout' }, graph, 0, fixtureExecution(graph)), 0, [identity], 0), 1, attempt, 5, 100);
  const snapshot = JSON.stringify(run), attemptSnapshot = JSON.stringify(attempt);
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('s', 'r', run.revision, snapshot, '{}');
  db.prepare('INSERT INTO run_receipts VALUES(?,?,?,?)').run('s', 'project', '{"project":true}', snapshot);
  db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run('s', 'a1', attempt.revision, attemptSnapshot);
  db.prepare('INSERT INTO attempt_receipts VALUES(?,?,?,?)').run('s', 'refuse', '{"refuse":true}', attemptSnapshot);
  db.exec(DOWNGRADE_TO_V58_LEDGER_SQL); db.close();
  return { path, backups, snapshot, attemptSnapshot };
}

it('backs up v58 and records v59 without reading or rewriting a byte; every v58 Run and attempt record still parses through the stores', async () => {
  const f = await fixture(); expect(ENVIRONMENT_READINESS_LEDGER_VERSION).toBe(59); expect(CURRENT_LEDGER_VERSION).toBe(70);
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-21T00:00:00Z'));
  expect(upgrade?.from).toBe(58); expect(upgrade?.to).toBe(CURRENT_LEDGER_VERSION);
  const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true });
  expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(58); backup.close();
  const db = new DatabaseSync(f.path);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
  const rows = [db.prepare('SELECT snapshot FROM runs').get()?.snapshot, db.prepare('SELECT snapshot FROM run_receipts').get()?.snapshot,
    db.prepare('SELECT snapshot FROM attempts').get()?.snapshot, db.prepare('SELECT snapshot FROM attempt_receipts').get()?.snapshot];
  expect(rows).toEqual([f.snapshot, f.snapshot, f.attemptSnapshot, f.attemptSnapshot]); db.close();
  // The widened contracts read the v58 shapes unchanged (no read-time migration).
  expect(runSnapshotSchema.parse(JSON.parse(f.snapshot))).toEqual(JSON.parse(f.snapshot));
  expect(attemptSnapshotSchema.parse(JSON.parse(f.attemptSnapshot))).toEqual(JSON.parse(f.attemptSnapshot));
  openSqliteLedger(f.path, options, 'forbid').close();
});

it('negative: a build refuses a newer ledger than its own (how alpha.49 meets a v59 ledger),', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.path); db.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1};`); db.close();
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  expect(() => openSqliteLedger(f.path, options)).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
});
