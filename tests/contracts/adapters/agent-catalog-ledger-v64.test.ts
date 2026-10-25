import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteLedger, migrateLedger, CURRENT_LEDGER_VERSION, AGENT_CATALOG_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_V63_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

// S7 agent/skill catalog core: ledger v64 (lane number after s6r1's v63; the lead renumbers at landing) adds only the catalog tables. No earlier
// row is read or rewritten; an older build refuses v64, so alpha.53/54 meet it as "newer ledger" (restore the pre-switch backup to roll back).
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const TABLES = ['agent_catalog_receipts', 'agent_definition_revisions', 'agent_definitions', 'skill_definition_revisions', 'skill_definitions'];
const catalog = (db: DatabaseSync) => db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN(${TABLES.map(() => '?').join(',')}) ORDER BY name`).all(...TABLES).map(row => row['name']);
/** A v63 ledger with no catalog rows, written as v63 wrote it. */
async function v63() {
  const root = await mkdtemp(join(tmpdir(), 'dn-agent-catalog-v64-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups);
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_V63_LEDGER_SQL); db.close();
  return { path, backups };
}

describe('ledger v64 agent/skill catalog migration', () => {
  it('pins the step: v64 is the agent catalog and the current ledger', () => {
    expect(AGENT_CATALOG_LEDGER_VERSION).toBe(64); expect(CURRENT_LEDGER_VERSION).toBe(71);
  });
  it('backs up a v63 ledger with no rows and adds only the empty catalog tables', async () => {
    const f = await v63();
    expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
    const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-23T00:00:00Z'));
    expect(upgrade).toMatchObject({ from: 63, to: 71 });
    const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true }), db = new DatabaseSync(f.path, { readOnly: true });
    try {
      expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(63); expect(catalog(backup)).toEqual([]);
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(71); expect(catalog(db)).toEqual(TABLES);
      for (const table of TABLES) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']).toBe(0);
    } finally { backup.close(); db.close(); }
  });
  it('revisions and receipts are append-only and current rows undeletable', async () => {
    const f = await v63(); const db = new DatabaseSync(f.path);
    try {
      migrateLedger(db, 'allow');
      db.prepare("INSERT INTO agent_definitions(scope_id,agent_id,revision,parent_id,seq,record) VALUES('s','a',1,NULL,1,'{}')").run();
      db.prepare("INSERT INTO agent_definition_revisions(scope_id,agent_id,revision,record) VALUES('s','a',1,'{}')").run();
      db.prepare("INSERT INTO skill_definitions(scope_id,skill_id,revision,seq,record) VALUES('s','k',1,1,'{}')").run();
      db.prepare("INSERT INTO skill_definition_revisions(scope_id,skill_id,revision,content_digest,record) VALUES('s','k',1,?,'{}')").run('a'.repeat(64));
      db.prepare("INSERT INTO agent_catalog_receipts(scope_id,command_id,kind,item_id,revision,record) VALUES('s','c','agent','a',1,'{}')").run();
      for (const sql of ['DELETE FROM agent_definitions', 'DELETE FROM skill_definitions', "UPDATE agent_definition_revisions SET record='x'", 'DELETE FROM agent_definition_revisions',
        "UPDATE skill_definition_revisions SET record='x'", 'DELETE FROM skill_definition_revisions', "UPDATE agent_catalog_receipts SET record='x'", 'DELETE FROM agent_catalog_receipts'])
        expect(() => db.exec(sql)).toThrow(/AGENT_CATALOG_APPEND_ONLY/);
      expect(() => db.prepare("INSERT INTO agent_catalog_receipts(scope_id,command_id,kind,item_id,revision,record) VALUES('s','d','tool','a',1,'{}')").run()).toThrow();
    } finally { db.close(); }
  });
  it('the v64 → v63 down step is exact for a ledger without catalog rows, and the upgrade replays to the same tables', async () => {
    const f = await v63(); const db = new DatabaseSync(f.path);
    try {
      migrateLedger(db, 'allow'); expect(catalog(db)).toEqual(TABLES);
      db.exec(DOWNGRADE_TO_V63_LEDGER_SQL); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(63); expect(catalog(db)).toEqual([]);
      migrateLedger(db, 'allow'); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(71); expect(catalog(db)).toEqual(TABLES);
    } finally { db.close(); }
  });
  it('negative: the step never adopts an existing catalog table, and a build refuses a ledger newer than its own', async () => {
    const f = await v63(); const db = new DatabaseSync(f.path);
    try {
      db.exec('CREATE TABLE skill_definitions(x)');
      db.exec('BEGIN IMMEDIATE'); expect(() => migrateLedger(db, 'allow')).toThrow(); db.exec('ROLLBACK');
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(63); expect(catalog(db)).toEqual(['skill_definitions']);
      db.exec(`DROP TABLE skill_definitions; PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1};`);
    } finally { db.close(); }
    expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
    expect(() => openSqliteLedger(f.path, options)).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  });
});
