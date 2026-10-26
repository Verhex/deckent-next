import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrateLedger, CURRENT_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';
import { DOWNGRADE_TO_PREVIOUS_LEDGER_SQL, PREVIOUS_LEDGER_VERSION } from '../../fixtures/ledger-previous.js';

it('v50 upgrades through metrics and later additive migrations; old Run and receipt bytes do not change', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateLedger(db, 'allow'); db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL);
    db.exec('DROP TABLE runs; DROP TABLE run_receipts; CREATE TABLE runs(scope_id TEXT,run_id TEXT,snapshot TEXT); CREATE TABLE run_receipts(snapshot TEXT);');
    const bytes = '{"schemaVersion":4,"legacy":true}';
    db.prepare("INSERT INTO runs VALUES('s','r',?)").run(bytes); db.prepare('INSERT INTO run_receipts VALUES(?)').run(bytes);
    migrateLedger(db, 'allow');
    expect(CURRENT_LEDGER_VERSION).toBe(72);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
    expect(db.prepare('SELECT snapshot FROM runs').get()?.snapshot).toBe(bytes);
    expect(db.prepare('SELECT snapshot FROM run_receipts').get()?.snapshot).toBe(bytes);
    expect(db.prepare('SELECT COUNT(*) AS n FROM acceptance_metrics').get()?.n).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='acceptance_metrics_attempt'").get()).toBeDefined();
    migrateLedger(db, 'forbid');
  } finally { db.close(); }
});
it('refuses a newer ledger before decoding records', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1};`);
    expect(() => migrateLedger(db, 'allow')).toThrow('ATTEMPT_STORE_VERSION');
    expect(() => requireLedgerVersion(db, 12)).toThrow('ATTEMPT_STORE_VERSION');
  } finally { db.close(); }
});
it('produces a genuine v50 fixture and replays current additive migrations without changing existing pool bytes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateLedger(db, 'allow');
    db.prepare('INSERT INTO execution_pools(pool_id,policy) VALUES(?,?)').run('pool', 'original-policy');
    db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL);
    expect(PREVIOUS_LEDGER_VERSION).toBe(50);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(PREVIOUS_LEDGER_VERSION);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'acceptance_metrics%'").all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='model_invocation_spend_unreconciled_holds'").get()).toBeDefined();
    migrateLedger(db, 'allow');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
    expect(db.prepare('SELECT policy FROM execution_pools').get()?.policy).toBe('original-policy');
    expect(db.prepare('SELECT COUNT(*) AS n FROM acceptance_metrics').get()?.n).toBe(0);
  } finally { db.close(); }
});
it('refuses a conflicting v50 metrics table and preserves the original schema version', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE acceptance_metrics(foreign_record TEXT); PRAGMA user_version=50;');
    expect(() => migrateLedger(db, 'allow')).toThrow('already exists');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(50);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='acceptance_metrics_attempt'").get()).toBeUndefined();
  } finally { db.close(); }
});
