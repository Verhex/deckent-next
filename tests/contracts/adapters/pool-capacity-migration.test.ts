import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger, CURRENT_LEDGER_VERSION, POOL_CAPACITY_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_V46_LEDGER_SQL, PREVIOUS_LEDGER_VERSION } from '../../fixtures/ledger-previous.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 1000 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-capacity-migration-')); roots.push(root); const path = join(root, 'ledger.db'), backups = join(root, 'backups');
  await mkdir(backups, { mode: 0o700 }); openSqliteLedger(path, options).close(); const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_V46_LEDGER_SQL);
  db.prepare('INSERT INTO execution_pools(pool_id,policy) VALUES(?,?)').run('p', 'original-policy'); return { path, backups, db };
}
it('upgrades v46 through v47 with a backup, preserving all original pool bytes; readers never migrate and newer schemas refuse', async () => {
  expect(PREVIOUS_LEDGER_VERSION).toBe(48); expect(CURRENT_LEDGER_VERSION).toBe(49); expect(POOL_CAPACITY_LEDGER_VERSION).toBe(47);
  const f = await fixture(); f.db.close(); expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgraded = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-03T09:00:00Z')); expect(upgraded).toMatchObject({ from: 46, to: CURRENT_LEDGER_VERSION });
  expect((await stat(upgraded!.backupPath)).isFile()).toBe(true);
  const current = new DatabaseSync(f.path), backup = new DatabaseSync(upgraded!.backupPath, { readOnly: true });
  try {
    expect(current.prepare('SELECT * FROM execution_pools').all()).toEqual(backup.prepare('SELECT * FROM execution_pools').all());
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(46);
    expect(current.prepare('SELECT * FROM execution_pool_capacities').all()).toEqual([]);
    expect(current.prepare('SELECT * FROM execution_pool_capacity_receipts').all()).toEqual([]);
    current.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1}`);
  } finally { current.close(); backup.close(); }
  for (const mode of ['forbid', 'allow'] as const) expect(() => openSqliteLedger(f.path, options, mode)).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
});
it('upgrade backup and directory have private POSIX 0600/0700 permissions', async context => {
  if (process.platform === 'win32') context.skip('POSIX_MODE_UNAVAILABLE: Windows chmod modes do not prove a private ACL');
  const f = await fixture(); f.db.close();
  const upgraded = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-03T09:00:00Z'));
  expect((await stat(upgraded!.backupPath)).mode & 0o777).toBe(0o600);
  expect((await stat(f.backups)).mode & 0o777).toBe(0o700);
});
it.each(['execution_pool_capacities', 'execution_pool_capacity_receipts'])('rejects same-name wrong-shape %s even with matching columns, without partial migration', async table => {
  const f = await fixture(); f.db.exec(table === 'execution_pool_capacities' ? `CREATE TABLE ${table}(pool_id TEXT,record TEXT)` : `CREATE TABLE ${table}(scope_id TEXT,command_id TEXT,record TEXT)`); f.db.close();
  await expect(upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-03T09:00:00Z'))).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  const check = new DatabaseSync(f.path, { readOnly: true }); try { expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(46); expect(check.prepare('SELECT policy FROM execution_pools').get()?.policy).toBe('original-policy'); } finally { check.close(); }
});
