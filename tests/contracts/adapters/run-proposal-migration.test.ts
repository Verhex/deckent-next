import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrateLedger, requireLedgerVersion, CURRENT_LEDGER_VERSION, RUN_PROPOSAL_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { DOWNGRADE_TO_V52_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
it('v52 refuses proposal reads and current writers; the explicit v53 transaction adds empty proposal receipts without rewriting old bytes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateLedger(db, 'allow'); db.exec(DOWNGRADE_TO_V52_LEDGER_SQL);
    const bytes = '{"historical":true}'; db.prepare('INSERT INTO execution_pools(pool_id,policy) VALUES(?,?)').run('pool', bytes);
    expect(() => requireLedgerVersion(db, RUN_PROPOSAL_LEDGER_VERSION)).toThrow('ATTEMPT_STORE_VERSION');
    expect(() => migrateLedger(db, 'forbid')).toThrow('ATTEMPT_STORE_VERSION');
    db.exec('BEGIN IMMEDIATE'); migrateLedger(db, 'allow'); db.exec('COMMIT');
    expect(CURRENT_LEDGER_VERSION).toBe(53); expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(53);
    expect(db.prepare('SELECT policy FROM execution_pools').get()!.policy).toBe(bytes);
    for (const table of ['run_proposals', 'run_proposal_receipts']) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
  } finally { db.close(); }
});
it('an additive migration failure rolls back all proposal tables and keeps the exact v52 version and old data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateLedger(db, 'allow'); db.exec(DOWNGRADE_TO_V52_LEDGER_SQL);
    db.exec('CREATE TABLE run_proposal_receipts(existing TEXT); BEGIN IMMEDIATE;');
    expect(() => migrateLedger(db, 'allow')).toThrow(/already exists/); db.exec('ROLLBACK');
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(52);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='run_proposals'").get()).toBeUndefined();
    expect(db.prepare('PRAGMA table_info(run_proposal_receipts)').all()[0]!.name).toBe('existing');
  } finally { db.close(); }
});
