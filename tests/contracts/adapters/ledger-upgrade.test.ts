import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CURRENT_LEDGER_VERSION, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_PREVIOUS_LEDGER_SQL, DOWNGRADE_TO_V35_LEDGER_SQL, PREVIOUS_LEDGER_VERSION } from '../../fixtures/ledger-previous.js';

const statRefusal = vi.hoisted(() => ({ path: null as string | null, error: undefined as unknown }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
    if (String(args[0]) === statRefusal.path) throw statRefusal.error;
    return actual.lstatSync(...args);
  } };
});
const roots: string[] = [];
afterEach(async () => { statRefusal.path = null; statRefusal.error = undefined; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const version = (path: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('PRAGMA user_version').get()?.user_version; } finally { db.close(); } };

it('backs up an older ledger with its version in the name, then migrates it to the current schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-ledger-upgrade-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL); db.close();
  const upgrade = await upgradeExistingProductLedger(path, options, backups, new Date('2026-09-24T00:00:00.000Z'));
  expect(upgrade).toEqual({ from: PREVIOUS_LEDGER_VERSION, to: CURRENT_LEDGER_VERSION,
    backupPath: join(backups, `ledger-v${PREVIOUS_LEDGER_VERSION}-2026-09-24T00-00-00-000Z.db`) });
  expect(version(path)).toBe(CURRENT_LEDGER_VERSION);
  expect(version(upgrade!.backupPath)).toBe(PREVIOUS_LEDGER_VERSION);
  // Current and missing ledgers are left untouched: no second backup, no file created.
  expect(await upgradeExistingProductLedger(path, options, backups, new Date())).toBeNull();
  expect(await upgradeExistingProductLedger(join(root, 'absent.db'), options, backups, new Date())).toBeNull();
  expect(await readdir(backups)).toHaveLength(1);
  await expect(stat(join(root, 'absent.db'))).rejects.toMatchObject({ code: 'ENOENT' });
  const refused = join(root, 'refused.db'); openSqliteLedger(refused, options).close();
  const old = new DatabaseSync(refused); old.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL); old.close();
  const date = new Date('2026-09-27T00:00:00.000Z');
  const foreign = Object.assign(new Error('LEDGER_BACKUP_EXISTS'), { code: 'EACCES' });
  statRefusal.path = join(backups, `ledger-v${PREVIOUS_LEDGER_VERSION}-2026-09-27T00-00-00-000Z.db`); statRefusal.error = foreign;
  await expect(upgradeExistingProductLedger(refused, options, backups, date)).rejects.toBe(foreign);
  expect(version(refused)).toBe(PREVIOUS_LEDGER_VERSION);
  expect(await readdir(backups)).toHaveLength(1);
});

it('keeps every allocation row across the v36 rebuild and then admits an allocation without a lifetime total', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-ledger-v36-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path);
  db.exec(DOWNGRADE_TO_V35_LEDGER_SQL);
  const record = JSON.stringify({ schemaVersion: 1, scopeId: 'live', allocationId: 'local-qwen-calls', maxCalls: 50, maxInFlight: 2, lifetimeCalls: 26, inFlight: 0 });
  db.prepare('INSERT INTO model_invocation_allocations VALUES(?,?,?,?,?,?,?)').run('live', 'local-qwen-calls', 50, 2, 26, 0, record);
  db.prepare('INSERT INTO model_invocation_allocation_checkpoints VALUES(?,?,?,?)').run('live', 'local-qwen-calls', 7, 'c'.repeat(64));
  // v35 cannot hold an allocation without a lifetime total.
  expect(() => db.prepare('INSERT INTO model_invocation_allocations VALUES(?,?,?,?,?,?,?)').run('live', 'x', null, 1, 0, 0, '{}')).toThrow(/NOT NULL/);
  db.close();
  await upgradeExistingProductLedger(path, options, backups, new Date('2026-09-25T00:00:00.000Z'));
  const after = new DatabaseSync(path);
  try {
    expect(after.prepare('SELECT scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record FROM model_invocation_allocations').all())
      .toEqual([{ scope_id: 'live', allocation_id: 'local-qwen-calls', max_calls: 50, max_in_flight: 2, lifetime_calls: 26, in_flight: 0, record }]);
    // The checkpoint child survives the rebuild and still references its parent.
    expect(after.prepare('SELECT scope_id,allocation_id,revision,digest FROM model_invocation_allocation_checkpoints').all())
      .toEqual([{ scope_id: 'live', allocation_id: 'local-qwen-calls', revision: 7, digest: 'c'.repeat(64) }]);
    expect(after.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    after.prepare('INSERT INTO model_invocation_allocations VALUES(?,?,?,?,?,?,?)').run('live', 'unbounded', null, 1, 0, 0, '{}');
    expect(() => after.prepare('INSERT INTO model_invocation_allocations VALUES(?,?,?,?,?,?,?)').run('live', 'zero', 0, 1, 0, 0, '{}')).toThrow(/CHECK/);
  } finally { after.close(); }
});

it.skipIf(process.platform === 'win32')('requires POSIX private file modes: ledger upgrade creates a 0600 backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-backup-private-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL); db.close();
  const upgrade = await upgradeExistingProductLedger(path, options, backups, new Date('2026-10-01T00:00:00.000Z'));
  expect((await stat(upgrade!.backupPath)).mode & 0o777).toBe(0o600);
});
