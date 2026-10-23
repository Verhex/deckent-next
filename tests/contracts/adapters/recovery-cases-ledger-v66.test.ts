import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger, migrateLedger, CURRENT_LEDGER_VERSION, RECOVERY_CASES_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteRecoveryStore, upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_V65_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

// S6R-4 (S6R-DESIGN §12; lane v66 at a55/integrate 1764a2538, the lead renumbers at landing): one additive table of recovery cases (open → gated →
// decided → applied | escalated), moved only forward by compare-and-swap; a closed case is final and no row is ever deleted. No earlier row is
// read or rewritten. An older build refuses v66 (alpha.54 is at v59 and already refuses every alpha.55 ledger: restore the pre-switch backup).
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const tables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_cases'").all().map(row => row['name']);
async function v65() {
  const root = await mkdtemp(join(tmpdir(), 'dn-recovery-v66-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups);
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_V65_LEDGER_SQL); db.close();
  return { path, backups };
}
const insert = (db: DatabaseSync, state: string, revision = 1) => db.prepare("INSERT INTO recovery_cases(scope_id,case_id,run_id,task_id,attempt_id,state,revision,record) VALUES('s','c','r','t','a',?,?,'{}')").run(state, revision);

it('pins the step: v66 is the recovery-case table (v67 agent standing is current)', () => {
  expect(RECOVERY_CASES_LEDGER_VERSION).toBe(66); expect(CURRENT_LEDGER_VERSION).toBe(70);
});
it('backs up a v65 ledger and adds only the empty recovery-case table; an older build (v65) refuses the result', async () => {
  const f = await v65();
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  expect(() => openSqliteRecoveryStore(f.path, options)).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-23T00:00:00Z'));
  expect(upgrade).toMatchObject({ from: 65, to: 70 });
  const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true }), db = new DatabaseSync(f.path, { readOnly: true });
  try {
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(65); expect(tables(backup)).toEqual([]);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(70); expect(tables(db)).toEqual(['recovery_cases']);
    expect(db.prepare('SELECT count(*) AS n FROM recovery_cases').get()?.['n']).toBe(0);
  } finally { backup.close(); db.close(); }
  openSqliteRecoveryStore(f.path, options).close();
});
it('a case moves only forward by one revision, keeps its identity, is final once applied or escalated, and is never deleted', async () => {
  const f = await v65(), db = new DatabaseSync(f.path);
  try {
    migrateLedger(db, 'allow'); insert(db, 'gated');
    expect(() => insert(db, 'gated')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.exec("INSERT INTO recovery_cases(scope_id,case_id,run_id,task_id,attempt_id,state,revision,record) VALUES('s','x','r','t','a','done',1,'{}')")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE recovery_cases SET state='applied',revision=3")).toThrow(/RECOVERY_CASE_APPEND_ONLY/);
    expect(() => db.exec("UPDATE recovery_cases SET attempt_id='b',revision=2")).toThrow(/RECOVERY_CASE_APPEND_ONLY/);
    db.exec("UPDATE recovery_cases SET state='applied',revision=2,record='{\"x\":1}'");
    expect(() => db.exec("UPDATE recovery_cases SET state='escalated',revision=3")).toThrow(/RECOVERY_CASE_APPEND_ONLY/);
    expect(() => db.exec('DELETE FROM recovery_cases')).toThrow(/RECOVERY_CASE_APPEND_ONLY/);
  } finally { db.close(); }
});
it('an existing recovery_cases table at v65 is refused, never adopted', async () => {
  const f = await v65(), db = new DatabaseSync(f.path);
  try {
    db.exec('CREATE TABLE recovery_cases(x TEXT)'); db.exec('BEGIN IMMEDIATE');
    expect(() => migrateLedger(db, 'allow')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' })); db.exec('ROLLBACK');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(65);
  } finally { db.close(); }
});
