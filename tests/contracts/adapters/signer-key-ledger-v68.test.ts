import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger, migrateLedger, CURRENT_LEDGER_VERSION, SIGNER_KEY_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_V67_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

// S8-5 (S8-DESIGN §8, §13; lane v68 after s81's v67, the lead renumbers at landing): signer keys per scope — the current row (active → revoked once,
// never deleted), its append-only revisions and command receipts. No earlier row is read or rewritten.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const TABLES = ['skill_signer_key_revisions', 'skill_signer_keys', 'skill_signer_receipts'];
const tables = (db: DatabaseSync) => db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN(${TABLES.map(() => '?').join(',')}) ORDER BY name`).all(...TABLES).map(row => row['name']);
async function v67() {
  const root = await mkdtemp(join(tmpdir(), 'dn-signer-v68-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups);
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_V67_LEDGER_SQL); db.close();
  return { path, backups };
}
const insert = (db: DatabaseSync, key: string, state = 'active', revision = 1) =>
  db.prepare("INSERT INTO skill_signer_keys(scope_id,key_id,state,revision,seq,record) VALUES('s',?,?,?,1,'{}')").run(key, state, revision);

it('pins the step: v68 is signer keys and the current ledger', () => {
  expect(SIGNER_KEY_LEDGER_VERSION).toBe(68); expect(CURRENT_LEDGER_VERSION).toBe(68);
});
it('backs up a v67 ledger and adds only the empty signer tables; an older build refuses the result', async () => {
  const f = await v67();
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-23T00:00:00Z'));
  expect(upgrade).toMatchObject({ from: 67, to: 68 });
  const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true }), db = new DatabaseSync(f.path, { readOnly: true });
  try {
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(67); expect(tables(backup)).toEqual([]);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(68); expect(tables(db)).toEqual(TABLES);
    for (const table of TABLES) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']).toBe(0);
  } finally { backup.close(); db.close(); }
});
it('a key moves only active → revoked (revision 1 → 2) with its id fixed, never back and never deleted; revisions and receipts are append-only', async () => {
  const f = await v67(), db = new DatabaseSync(f.path);
  try {
    migrateLedger(db, 'allow'); insert(db, 'k');
    expect(() => insert(db, 'k')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert(db, 'x', 'expired')).toThrow(/CHECK/);
    for (const sql of ["UPDATE skill_signer_keys SET record='x'", "UPDATE skill_signer_keys SET key_id='y',state='revoked',revision=2"]) expect(() => db.exec(sql)).toThrow(/AGENT_CATALOG_APPEND_ONLY/);
    db.exec("UPDATE skill_signer_keys SET state='revoked',revision=2,record='r'");
    for (const sql of ["UPDATE skill_signer_keys SET state='active',revision=1", "UPDATE skill_signer_keys SET record='again'", 'DELETE FROM skill_signer_keys'])
      expect(() => db.exec(sql)).toThrow(/AGENT_CATALOG_APPEND_ONLY/);
    db.prepare("INSERT INTO skill_signer_key_revisions(scope_id,key_id,revision,record) VALUES('s','k',1,'{}')").run();
    db.prepare("INSERT INTO skill_signer_receipts(scope_id,command_id,record) VALUES('s','c','{}')").run();
    for (const sql of ["UPDATE skill_signer_key_revisions SET record='x'", 'DELETE FROM skill_signer_key_revisions', "UPDATE skill_signer_receipts SET record='x'", 'DELETE FROM skill_signer_receipts'])
      expect(() => db.exec(sql)).toThrow(/AGENT_CATALOG_APPEND_ONLY/);
  } finally { db.close(); }
});
it('the v68 → v67 down step is exact for a ledger without signer rows; negative: an existing signer table is refused, never adopted', async () => {
  const f = await v67(); let db = new DatabaseSync(f.path);
  try {
    migrateLedger(db, 'allow'); expect(tables(db)).toEqual(TABLES);
    db.exec(DOWNGRADE_TO_V67_LEDGER_SQL); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(67); expect(tables(db)).toEqual([]);
    db.exec('CREATE TABLE skill_signer_keys(x)');
    db.exec('BEGIN IMMEDIATE'); expect(() => migrateLedger(db, 'allow')).toThrow(); db.exec('ROLLBACK');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(67);
    db.exec('DROP TABLE skill_signer_keys'); migrateLedger(db, 'allow'); expect(tables(db)).toEqual(TABLES);
  } finally { db.close(); }
  db = new DatabaseSync(f.path); db.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1};`); db.close();
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
});
