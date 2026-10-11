import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrateLedger, CURRENT_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';

it('v51 adds only the empty metrics table and index; old Run and receipt bytes do not change', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE runs(snapshot TEXT); CREATE TABLE run_receipts(snapshot TEXT); PRAGMA user_version=50;');
    const bytes = '{"schemaVersion":4,"legacy":true}';
    db.prepare('INSERT INTO runs VALUES(?)').run(bytes); db.prepare('INSERT INTO run_receipts VALUES(?)').run(bytes);
    migrateLedger(db, 'allow');
    expect(CURRENT_LEDGER_VERSION).toBe(51);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(51);
    expect(db.prepare('SELECT snapshot FROM runs').get()?.snapshot).toBe(bytes);
    expect(db.prepare('SELECT snapshot FROM run_receipts').get()?.snapshot).toBe(bytes);
    expect(db.prepare('SELECT COUNT(*) AS n FROM acceptance_metrics').get()?.n).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='acceptance_metrics_attempt'").get()).toBeDefined();
    migrateLedger(db, 'forbid');
  } finally { db.close(); }
});
it('refuses a newer ledger before decoding records (old alpha.28 floor ceiling)', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA user_version=52;');
    expect(() => migrateLedger(db, 'allow')).toThrow('ATTEMPT_STORE_VERSION');
    expect(() => requireLedgerVersion(db, 12)).toThrow('ATTEMPT_STORE_VERSION');
  } finally { db.close(); }
});
