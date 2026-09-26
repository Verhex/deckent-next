import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CURRENT_LEDGER_VERSION, openSqliteLedger, readScopeCompanies, registerLedgerScopes } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_PREVIOUS_LEDGER_SQL, PREVIOUS_LEDGER_VERSION } from '../../fixtures/ledger-previous.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const at = new Date('2026-09-27T00:00:00.000Z');
async function ledger() {
  const root = await mkdtemp(join(tmpdir(), 'dn-scope-registry-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  openSqliteLedger(path, options).close();
  return { path, backups };
}
const rows = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
const version = (path: string) => rows(path, 'PRAGMA user_version')[0]?.user_version;

it('upgrades a real v38 ledger to v39: versioned 0600 backup first, every row kept, every present scope pinned to the configured company', async () => {
  const { path, backups } = await ledger();
  expect(CURRENT_LEDGER_VERSION).toBe(39); expect(PREVIOUS_LEDGER_VERSION).toBe(38);
  const db = new DatabaseSync(path);
  db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL);
  db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run('alpha', 'a1', 1, '{"attempt":1}');
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('beta', 'r1', 0, '{"run":1}', '{}');
  db.prepare("INSERT INTO agent_turns VALUES(?,?,?,?,'finished',?)").run('gamma', 't1', 'p', 'd', '{"turn":1}');
  db.prepare('INSERT INTO worker_event_logs VALUES(?,?,?)').run('alpha', 'a1', '{"log":1}');
  const before = { attempts: db.prepare('SELECT * FROM attempts').all(), runs: db.prepare('SELECT * FROM runs').all() };
  db.close();
  expect(version(path)).toBe(38);
  expect(rows(path, "SELECT name FROM sqlite_schema WHERE name IN('scope_registry','companies')")).toEqual([]);

  const upgrade = await upgradeExistingProductLedger(path, options, backups, at, undefined, 'acme');
  const backupPath = join(backups, 'ledger-v38-2026-09-27T00-00-00-000Z.db');
  expect(upgrade).toEqual({ from: 38, to: 39, backupPath });
  expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
  expect(version(backupPath)).toBe(38);
  expect(rows(backupPath, 'SELECT * FROM attempts')).toEqual(before.attempts);
  expect(rows(backupPath, "SELECT name FROM sqlite_schema WHERE name IN('scope_registry','companies')")).toEqual([]);

  expect(version(path)).toBe(39);
  expect(rows(path, 'SELECT * FROM attempts')).toEqual(before.attempts); expect(rows(path, 'SELECT * FROM runs')).toEqual(before.runs);
  expect(rows(path, 'SELECT company_id FROM companies')).toEqual([{ company_id: 'acme' }]);
  expect(rows(path, 'SELECT scope_id,company_id,origin FROM scope_registry ORDER BY scope_id')).toEqual([
    { scope_id: 'alpha', company_id: 'acme', origin: 'migration' }, { scope_id: 'beta', company_id: 'acme', origin: 'migration' },
    { scope_id: 'gamma', company_id: 'acme', origin: 'migration' }]);
  expect(rows(path, 'PRAGMA foreign_key_check')).toEqual([]);
  expect(readScopeCompanies(path, 100, ['alpha', 'missing'])).toEqual(new Map([['alpha', 'acme']]));
  // Current ledgers are left alone: no second backup.
  expect(await upgradeExistingProductLedger(path, options, backups, new Date(), undefined, 'other')).toBeNull();
  expect(await readdir(backups)).toHaveLength(1);
});

it('gives a ledger without scoped rows empty registry tables and invents no company', async () => {
  const { path, backups } = await ledger();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL); db.close();
  expect(await upgradeExistingProductLedger(path, options, backups, at, undefined, 'acme')).toMatchObject({ from: 38, to: 39 });
  expect(rows(path, 'SELECT * FROM companies')).toEqual([]); expect(rows(path, 'SELECT * FROM scope_registry')).toEqual([]);
});

it('rolls a failed v39 migration back in one transaction: the ledger stays v38 with every row and the backup remains', async () => {
  const { path, backups } = await ledger();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL);
  db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run('alpha', 'a1', 1, '{}');
  // A foreign same-name table with another shape must not be adopted silently.
  db.exec('CREATE TABLE scope_registry(unrelated TEXT)'); db.close();
  await expect(upgradeExistingProductLedger(path, options, backups, at, undefined, 'acme')).rejects.toThrow();
  expect(version(path)).toBe(38); expect(rows(path, 'SELECT scope_id FROM attempts')).toEqual([{ scope_id: 'alpha' }]);
  expect(rows(path, "SELECT name FROM sqlite_schema WHERE name='companies'")).toEqual([]);
  expect(await readdir(backups)).toEqual(['ledger-v38-2026-09-27T00-00-00-000Z.db']);
});

it('refuses newer and older schemas on writer opens and on the read-only registry lookup; forbid never migrates', async () => {
  const { path } = await ledger();
  const newer = new DatabaseSync(path); newer.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1};`); newer.close();
  for (const mode of ['allow', 'forbid'] as const) expect(() => openSqliteLedger(path, options, mode)).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  expect(() => readScopeCompanies(path, 100, ['s'])).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const older = await ledger();
  const db = new DatabaseSync(older.path); db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL); db.close();
  expect(() => openSqliteLedger(older.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  expect(() => readScopeCompanies(older.path, 100, ['s'])).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  expect(version(older.path)).toBe(38);
  expect(readScopeCompanies(join(older.path, '..', 'absent.db'), 100, ['s'])).toEqual(new Map());
});

it('registers insert-only: the company column is written, a pin never moves to another company', async () => {
  const { path } = await ledger();
  expect(registerLedgerScopes(path, options, 'default', ['own', 'shared', 'own'])).toEqual({ registered: ['own', 'shared'], pinnedElsewhere: [] });
  expect(registerLedgerScopes(path, options, 'acme', ['shared', 'new'])).toEqual({ registered: ['new'], pinnedElsewhere: ['shared'] });
  expect(rows(path, 'SELECT scope_id,company_id,origin FROM scope_registry ORDER BY scope_id')).toEqual([
    { scope_id: 'new', company_id: 'acme', origin: 'start' }, { scope_id: 'own', company_id: 'default', origin: 'start' },
    { scope_id: 'shared', company_id: 'default', origin: 'start' }]);
  expect(rows(path, 'SELECT company_id FROM companies ORDER BY company_id')).toEqual([{ company_id: 'acme' }, { company_id: 'default' }]);
  expect(() => registerLedgerScopes(path, options, 'Not Valid', ['x'])).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_OPTIONS' }));
});
