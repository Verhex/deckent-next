import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createProviderSpendAccount, createProviderSpendCheckpoint } from '#engine/index.js';
import { openSqliteLedger, migrateLedger, CURRENT_LEDGER_VERSION, PROVIDER_SPEND_PERIOD_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_V70_LEDGER_SQL, DOWNGRADE_TO_V71_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

// alpha.56 BP (6a13cb3a3): v72 archives each period-less spend checkpoint once and pins its first local month boundary (the transform itself:
// provider-spend-migration.test.ts). This file holds the step convention: pin, backup, older-build refusal, down step and contradictory schema.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const history = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_spend_period_history'").all().length;
const account = (db: DatabaseSync) => db.prepare('SELECT record,revision FROM provider_spend_accounts').get() as { record: string; revision: number };
async function v71() {
  const root = await mkdtemp(join(tmpdir(), 'dn-spend-period-v72-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups);
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path);
  try {
    db.exec(DOWNGRADE_TO_V71_LEDGER_SQL);
    const budget = { schemaVersion: 1, scopeId: 'scope', budgetId: 'legacy', revision: 1, currency: 'USD', limitMinorUnits: 100 };
    const before = createProviderSpendCheckpoint({ ...createProviderSpendAccount(budget), settledExactMinorUnits: '40', settledMinorUnits: 40 }, 1, 0);
    db.prepare('INSERT INTO provider_spend_accounts(scope_id,record,revision,reservation_count,digest) VALUES(?,?,?,?,?)')
      .run('scope', JSON.stringify(before.account), before.revision, before.reservationCount, before.digest);
    return { path, backups, before };
  } finally { db.close(); }
}

it('pins the step: v72 is the budget periods and the current ledger', () => {
  expect(PROVIDER_SPEND_PERIOD_LEDGER_VERSION).toBe(72); expect(CURRENT_LEDGER_VERSION).toBe(72);
});
it('backs up a v71 ledger before the upgrade; the backup keeps the period-less record; this build refuses the v71 ledger without the upgrade', async () => {
  const f = await v71();
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-26T00:00:00Z'));
  expect(upgrade).toMatchObject({ from: 71, to: 72 });
  const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true }), db = new DatabaseSync(f.path, { readOnly: true });
  try {
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(71); expect(history(backup)).toBe(0);
    expect(account(backup)).toEqual({ record: JSON.stringify(f.before.account), revision: 1 });
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(72);
    expect(account(db).revision).toBe(2); expect(JSON.parse(account(db).record)).toMatchObject({ settledMinorUnits: 40, period: { legacyTransition: true } });
    expect(db.prepare('SELECT checkpoint_revision FROM provider_spend_period_history').all()).toEqual([{ checkpoint_revision: 1 }]);
  } finally { backup.close(); db.close(); }
});
it('the v72 → v71 down step is exact for a ledger without spend accounts; negative: an existing history table at v71 is refused, never adopted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-spend-period-v72-')); roots.push(root);
  const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path);
  try {
    db.exec(DOWNGRADE_TO_V71_LEDGER_SQL); expect(history(db)).toBe(0);
    db.exec('CREATE TABLE provider_spend_period_history(x)');
    db.exec('BEGIN IMMEDIATE'); expect(() => migrateLedger(db, 'allow')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' })); db.exec('ROLLBACK');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(71);
    db.exec(DOWNGRADE_TO_V70_LEDGER_SQL); migrateLedger(db, 'allow');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(72); expect(history(db)).toBe(1);
  } finally { db.close(); }
});
