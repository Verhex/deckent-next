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
    expect(CURRENT_LEDGER_VERSION).toBe(73); expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(73);
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

it('U4-1p v73: backup precedes the protocol fence, v72 refuses writes and rollback restores old bytes', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises'), { join } = await import('node:path'), { tmpdir } = await import('node:os');
  const { upgradeExistingLedger, openSqliteLedger, RUN_INTENT_LEDGER_VERSION } = await import('#adapters/core/sqlite-ledger/index.js');
  const root = await mkdtemp(join(tmpdir(), 'intent-step-')), path = join(root, 'ledger.db'), backup = join(root, 'backup');
  const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
  try {
    await mkdir(backup); const seed = openSqliteLedger(path, options); seed.exec('PRAGMA user_version=72'); seed.close();
    expect(() => openSqliteLedger(path, options, 'forbid')).toThrow('ATTEMPT_STORE_VERSION');
    const step = upgradeExistingLedger(path, options, backup, new Date('2026-10-26T00:00:00Z'))!;
    expect(step).toMatchObject({ from: 72, to: 73 }); expect(RUN_INTENT_LEDGER_VERSION).toBe(73);
    const old = new DatabaseSync(step.backupPath, { readOnly: true });
    try { expect(old.prepare('PRAGMA user_version').get()?.user_version).toBe(72); } finally { old.close(); }
    const current = openSqliteLedger(path, options, 'forbid'); current.close();
    // Restore is the supported down step. No destructive in-place conversion is offered.
    const { copyFile } = await import('node:fs/promises'); await rm(path); await copyFile(step.backupPath, path);
    const restored = new DatabaseSync(path); try { expect(restored.prepare('PRAGMA user_version').get()?.user_version).toBe(72); } finally { restored.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
