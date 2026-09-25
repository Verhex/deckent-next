import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CURRENT_LEDGER_VERSION, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_PREVIOUS_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const version = (path: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('PRAGMA user_version').get()?.user_version; } finally { db.close(); } };

it('backs up an older ledger with its version in the name, then migrates it to the current schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-ledger-upgrade-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL); db.close();
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

it('keeps every allocation row across the v36 rebuild and then admits an allocation without a lifetime total', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-ledger-v36-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path);
  db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL);
  const record = JSON.stringify({ schemaVersion: 1, scopeId: 'live', allocationId: 'local-qwen-calls', maxCalls: 50, maxInFlight: 2, lifetimeCalls: 26, inFlight: 0 });
  db.prepare('INSERT INTO model_invocation_allocations VALUES(?,?,?,?,?,?,?)').run('live', 'local-qwen-calls', 50, 2, 26, 0, record);
  // v35 cannot hold an allocation without a lifetime total.
  expect(() => db.prepare('INSERT INTO model_invocation_allocations VALUES(?,?,?,?,?,?,?)').run('live', 'x', null, 1, 0, 0, '{}')).toThrow(/NOT NULL/);
  db.close();
  await upgradeExistingProductLedger(path, options, backups, new Date('2026-09-25T00:00:00.000Z'));
  const after = new DatabaseSync(path);
  try {
    expect(after.prepare('SELECT scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record FROM model_invocation_allocations').all())
      .toEqual([{ scope_id: 'live', allocation_id: 'local-qwen-calls', max_calls: 50, max_in_flight: 2, lifetime_calls: 26, in_flight: 0, record }]);
    after.prepare('INSERT INTO model_invocation_allocations VALUES(?,?,?,?,?,?,?)').run('live', 'unbounded', null, 1, 0, 0, '{}');
    expect(() => after.prepare('INSERT INTO model_invocation_allocations VALUES(?,?,?,?,?,?,?)').run('live', 'zero', 0, 1, 0, 0, '{}')).toThrow(/CHECK/);
  } finally { after.close(); }
});
