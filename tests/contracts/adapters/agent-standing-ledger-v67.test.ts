import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger, migrateLedger, CURRENT_LEDGER_VERSION, AGENT_STANDING_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_V66_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

// S8-1a (S8-DESIGN §7, §13; lane v67 after s6r4's v66, the lead renumbers at landing): agent standing per (agent revision, WorkClass) — the
// current row (moved forward only by one standing revision, never deleted), its append-only history, and the append-only command receipts the
// S8-4 person cards use. No earlier row is read or rewritten; agents defined before v67 have no standing row and are not selectable until revised.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const TABLES = ['agent_standing_receipts', 'agent_standing_revisions', 'agent_standings'];
const tables = (db: DatabaseSync) => db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN(${TABLES.map(() => '?').join(',')}) ORDER BY name`).all(...TABLES).map(row => row['name']);
async function v66() {
  const root = await mkdtemp(join(tmpdir(), 'dn-agent-standing-v67-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups);
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_V66_LEDGER_SQL); db.close();
  return { path, backups };
}
const insert = (db: DatabaseSync, standing: string, revision = 1) => db.prepare("INSERT INTO agent_standings(scope_id,agent_id,revision,work_class,standing,standing_revision,record) VALUES('s','a',1,'feature',?,?,'{}')").run(standing, revision);

it('pins the step: v67 is agent standing (v70, the S8-3 suggestions, is current)', () => {
  expect(AGENT_STANDING_LEDGER_VERSION).toBe(67); expect(CURRENT_LEDGER_VERSION).toBe(70);
});
it('N25: backs up a v66 ledger with no agents and adds only the empty standing tables; an older build refuses the result', async () => {
  const f = await v66();
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-23T00:00:00Z'));
  expect(upgrade).toMatchObject({ from: 66, to: 70 });
  const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true }), db = new DatabaseSync(f.path, { readOnly: true });
  try {
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(66); expect(tables(backup)).toEqual([]);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(70); expect(tables(db)).toEqual(TABLES);
    for (const table of TABLES) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']).toBe(0);
  } finally { backup.close(); db.close(); }
});
it('a standing moves forward by exactly one revision with its key fixed, is never deleted; history and receipts are append-only', async () => {
  const f = await v66(), db = new DatabaseSync(f.path);
  try {
    migrateLedger(db, 'allow'); insert(db, 'candidate');
    expect(() => insert(db, 'candidate')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.exec("INSERT INTO agent_standings(scope_id,agent_id,revision,work_class,standing,standing_revision,record) VALUES('s','b',1,'feature','promoted',1,'{}')")).toThrow(/CHECK/);
    db.exec("UPDATE agent_standings SET standing='active',standing_revision=2");
    for (const sql of ["UPDATE agent_standings SET standing='candidate',standing_revision=4", "UPDATE agent_standings SET work_class='docs',standing_revision=3",
      "UPDATE agent_standings SET revision=2,standing_revision=3", 'DELETE FROM agent_standings']) expect(() => db.exec(sql)).toThrow(/AGENT_CATALOG_APPEND_ONLY/);
    db.prepare("INSERT INTO agent_standing_revisions(scope_id,agent_id,revision,work_class,standing_revision,record) VALUES('s','a',1,'feature',1,'{}')").run();
    db.prepare("INSERT INTO agent_standing_receipts(scope_id,command_id,record) VALUES('s','c','{}')").run();
    for (const sql of ["UPDATE agent_standing_revisions SET record='x'", 'DELETE FROM agent_standing_revisions', "UPDATE agent_standing_receipts SET record='x'", 'DELETE FROM agent_standing_receipts'])
      expect(() => db.exec(sql)).toThrow(/AGENT_CATALOG_APPEND_ONLY/);
  } finally { db.close(); }
});
it('the v67 → v66 down step is exact for a ledger without standing rows; negative: an existing standing table is refused, never adopted', async () => {
  const f = await v66(); let db = new DatabaseSync(f.path);
  try {
    migrateLedger(db, 'allow'); expect(tables(db)).toEqual(TABLES);
    db.exec(DOWNGRADE_TO_V66_LEDGER_SQL); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(66); expect(tables(db)).toEqual([]);
    db.exec('CREATE TABLE agent_standings(x)');
    db.exec('BEGIN IMMEDIATE'); expect(() => migrateLedger(db, 'allow')).toThrow(); db.exec('ROLLBACK');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(66);
    db.exec('DROP TABLE agent_standings'); migrateLedger(db, 'allow'); expect(tables(db)).toEqual(TABLES);
  } finally { db.close(); }
  db = new DatabaseSync(f.path); db.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1};`); db.close();
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
});
