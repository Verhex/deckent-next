import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CURRENT_LEDGER_VERSION, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const version = (path: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('PRAGMA user_version').get()?.user_version; } finally { db.close(); } };

it('backs up an older ledger with its version in the name, then migrates it to the current schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-ledger-upgrade-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path); db.exec(`DROP TABLE worker_event_logs; PRAGMA user_version=${CURRENT_LEDGER_VERSION - 1};`); db.close();
  const upgrade = await upgradeExistingProductLedger(path, options, backups, new Date('2026-09-24T00:00:00.000Z'));
  expect(upgrade).toEqual({ from: CURRENT_LEDGER_VERSION - 1, to: CURRENT_LEDGER_VERSION,
    backupPath: join(backups, `ledger-v${CURRENT_LEDGER_VERSION - 1}-2026-09-24T00-00-00-000Z.db`) });
  expect(version(path)).toBe(CURRENT_LEDGER_VERSION);
  expect(version(upgrade!.backupPath)).toBe(CURRENT_LEDGER_VERSION - 1);
  expect((await stat(upgrade!.backupPath)).mode & 0o777).toBe(0o600);
  // Current and missing ledgers are left untouched: no second backup, no file created.
  expect(await upgradeExistingProductLedger(path, options, backups, new Date())).toBeNull();
  expect(await upgradeExistingProductLedger(join(root, 'absent.db'), options, backups, new Date())).toBeNull();
  expect(await readdir(backups)).toHaveLength(1);
  await expect(stat(join(root, 'absent.db'))).rejects.toMatchObject({ code: 'ENOENT' });
});
