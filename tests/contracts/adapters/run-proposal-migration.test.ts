import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrateLedger, requireLedgerVersion, CURRENT_LEDGER_VERSION, RUN_PROPOSAL_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { DOWNGRADE_TO_V51_LEDGER_SQL, DOWNGRADE_TO_V52_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
it('v52 refuses proposal reads and current writers; the explicit v53 transaction adds empty proposal receipts without rewriting old bytes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateLedger(db, 'allow'); db.exec(DOWNGRADE_TO_V52_LEDGER_SQL);
    const bytes = '{"historical":true}'; db.prepare('INSERT INTO execution_pools(pool_id,policy) VALUES(?,?)').run('pool', bytes);
    expect(() => requireLedgerVersion(db, RUN_PROPOSAL_LEDGER_VERSION)).toThrow('ATTEMPT_STORE_VERSION');
    expect(() => migrateLedger(db, 'forbid')).toThrow('ATTEMPT_STORE_VERSION');
    db.exec('BEGIN IMMEDIATE'); migrateLedger(db, 'allow'); db.exec('COMMIT');
    expect(CURRENT_LEDGER_VERSION).toBe(64); expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(64);
    expect(db.prepare('SELECT policy FROM execution_pools').get()!.policy).toBe(bytes);
    for (const table of ['run_proposals', 'run_proposal_receipts']) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
  } finally { db.close(); }
});
it('an additive migration failure rolls back all proposal tables and keeps the exact v52 version and old data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateLedger(db, 'allow'); db.exec(DOWNGRADE_TO_V52_LEDGER_SQL);
    db.exec('CREATE TABLE run_proposal_receipts(existing TEXT); BEGIN IMMEDIATE;');
    expect(() => migrateLedger(db, 'allow')).toThrow('ATTEMPT_STORE_VERSION'); db.exec('ROLLBACK');
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(52);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='run_proposals'").get()).toBeUndefined();
    expect(db.prepare('PRAGMA table_info(run_proposal_receipts)').all()[0]!.name).toBe('existing');
  } finally { db.close(); }
});

it('the v51 service shape reaches the same v53 schema, preserves history and reopens without another migration', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateLedger(db, 'allow');
    const schema = () => db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const current = schema(); db.exec(DOWNGRADE_TO_V51_LEDGER_SQL);
    const bytes = '{"historical":true}'; db.prepare('INSERT INTO execution_pools(pool_id,policy) VALUES(?,?)').run('pool', bytes);
    db.exec('BEGIN IMMEDIATE'); migrateLedger(db, 'allow'); db.exec('COMMIT');
    expect(schema()).toEqual(current);
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(CURRENT_LEDGER_VERSION);
    expect(db.prepare('SELECT policy FROM execution_pools').get()!.policy).toBe(bytes);
    migrateLedger(db, 'allow'); migrateLedger(db, 'forbid'); expect(schema()).toEqual(current);
    db.exec("INSERT INTO run_proposal_receipts VALUES('s','c',1,'{}')");
    expect(() => db.exec("UPDATE run_proposal_receipts SET record='changed' WHERE scope_id='s'")).toThrow('RUN_PROPOSAL_APPEND_ONLY');
    expect(() => db.exec("DELETE FROM run_proposal_receipts WHERE scope_id='s'")).toThrow('RUN_PROPOSAL_APPEND_ONLY');
  } finally { db.close(); }
});
