import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger, migrateLedger, CURRENT_LEDGER_VERSION, WORKER_ASSIGNMENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { createRun, runSnapshotSchema } from '#domain/index.js';
import { DOWNGRADE_TO_V61_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
import { fixtureExecution } from '../support/execution-registry.js';

// ATAMA-1: ledger v62 is a version step only. Run graphs may now hold work input v2 and execution snapshots a sealed assignment; every v61
// record parses unchanged and nothing is read or rewritten, while the step keeps an older build (alpha.53/54 refuse a newer ledger) away.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
async function v61() {
  const root = await mkdtemp(join(tmpdir(), 'dn-assignment-v62-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups);
  openSqliteLedger(path, options).close();
  const graph = { schemaVersion: 4, revision: 1, tasks: [{ id: 'task', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  const snapshot = JSON.stringify(createRun({ scopeId: 's', runId: 'r', layoutRevision: 'layout' }, graph, 0, fixtureExecution(graph)));
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('s', 'r', 0, snapshot, '{}');
  db.prepare('INSERT INTO run_receipts VALUES(?,?,?,?)').run('s', 'create', '{"create":true}', snapshot);
  db.exec(DOWNGRADE_TO_V61_LEDGER_SQL); db.close();
  return { path, backups, snapshot };
}

it('pins the step: v62 is the assignment step', () => {
  expect(WORKER_ASSIGNMENT_LEDGER_VERSION).toBe(62); expect(CURRENT_LEDGER_VERSION).toBe(70);
});
it('backs up v61 and records v62 (then v63, v64) without rewriting a byte; v61 Run records still parse', async () => {
  const f = await v61();
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-23T00:00:00Z'));
  expect(upgrade).toMatchObject({ from: 61, to: 70 });
  const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true });
  try { expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(61); } finally { backup.close(); }
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(70);
    expect([db.prepare('SELECT snapshot FROM runs').get()?.snapshot, db.prepare('SELECT snapshot FROM run_receipts').get()?.snapshot]).toEqual([f.snapshot, f.snapshot]);
  } finally { db.close(); }
  expect(runSnapshotSchema.parse(JSON.parse(f.snapshot))).toEqual(JSON.parse(f.snapshot));
  openSqliteLedger(f.path, options, 'forbid').close();
});
it('the v62 → v61 fixture is exact for a ledger without new records and the upgrade replays to the same state', async () => {
  const f = await v61(); const db = new DatabaseSync(f.path);
  try {
    migrateLedger(db, 'allow'); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(70);
    db.exec(DOWNGRADE_TO_V61_LEDGER_SQL); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(61);
    migrateLedger(db, 'allow'); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(70);
    expect(db.prepare('SELECT snapshot FROM runs').get()?.snapshot).toBe(f.snapshot);
  } finally { db.close(); }
});
it('negative: a build refuses a ledger newer than its own (how alpha.53/54 meet v62)', async () => {
  const f = await v61(); const db = new DatabaseSync(f.path); db.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1};`); db.close();
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  expect(() => openSqliteLedger(f.path, options)).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
});
