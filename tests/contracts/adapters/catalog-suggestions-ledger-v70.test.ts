import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger, migrateLedger, CURRENT_LEDGER_VERSION, CATALOG_SUGGESTION_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteAgentCatalogStore, upgradeExistingProductLedger } from '#adapters/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { DOWNGRADE_TO_V68_LEDGER_SQL, DOWNGRADE_TO_V69_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

// S8-3/S8-4 (S8-DESIGN §6, §13; lane v70 after s82's v69, the lead renumbers at landing): sealed catalog suggestions whose state moves once from `open`
// with append-only history, and the aggregator's rebuildable per-key window cache. Additive: no earlier row is read or rewritten; an older build refuses v70.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const TABLES = ['catalog_evolution_windows', 'catalog_suggestion_states', 'catalog_suggestions'];
const tables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('catalog_evolution_windows','catalog_suggestion_states','catalog_suggestions') ORDER BY name")
  .all().map(row => row['name']);
async function ledger(downgrade?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dn-catalog-suggestions-v70-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups);
  openSqliteLedger(path, options).close();
  if (downgrade) { const db = new DatabaseSync(path); db.exec(downgrade); db.close(); }
  return { path, backups };
}
it('pins the step: v70 is the catalog suggestions and the current ledger', () => {
  expect(CATALOG_SUGGESTION_LEDGER_VERSION).toBe(70); expect(CURRENT_LEDGER_VERSION).toBe(70);
});
it('N25: backs up a v69 ledger with no agents and adds only the empty tables; an older build refuses the result; nothing earlier is rewritten', async () => {
  const f = await ledger(DOWNGRADE_TO_V69_LEDGER_SQL);
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  expect(() => openSqliteAgentCatalogStore(f.path, options, createHmacIntegrity('k', Buffer.alloc(32, 1)), 'read')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-24T00:00:00Z'));
  expect(upgrade).toMatchObject({ from: 69, to: 70 });
  const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true }), db = new DatabaseSync(f.path, { readOnly: true });
  try {
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(69); expect(tables(backup)).toEqual([]);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(70); expect(tables(db)).toEqual(TABLES);
    for (const table of TABLES) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']).toBe(0);
  } finally { backup.close(); db.close(); }
});
it('a suggestion row moves its state once from open by one revision; its content, kind, key and seq never change; history and rows are never deleted', async () => {
  const f = await ledger(), db = new DatabaseSync(f.path);
  try {
    db.exec("INSERT INTO catalog_suggestions VALUES('s','a','promote-agent','k','open',1,1,'{}','{}')");
    expect(() => db.exec("INSERT INTO catalog_suggestions VALUES('s','b','promote-agent','k','pending',1,2,'{}','{}')")).toThrow(/CHECK/);
    for (const sql of ["UPDATE catalog_suggestions SET state='decided',state_revision=3", "UPDATE catalog_suggestions SET state='open',state_revision=2", "UPDATE catalog_suggestions SET record='x',state='decided',state_revision=2",
      "UPDATE catalog_suggestions SET key_digest='j',state='decided',state_revision=2", 'DELETE FROM catalog_suggestions']) expect(() => db.exec(sql), sql).toThrow(/AGENT_CATALOG_APPEND_ONLY/);
    db.exec("UPDATE catalog_suggestions SET state='decided',state_revision=2,state_record='{\"x\":1}'");
    expect(() => db.exec("UPDATE catalog_suggestions SET state='dismissed',state_revision=3")).toThrow(/AGENT_CATALOG_APPEND_ONLY/);
    db.exec("INSERT INTO catalog_suggestion_states VALUES('s','a',1,'{}')"); db.exec("INSERT INTO catalog_evolution_windows VALUES('s','k','{}')");
    for (const sql of ["UPDATE catalog_suggestion_states SET record='x'", 'DELETE FROM catalog_suggestion_states', 'DELETE FROM catalog_evolution_windows'])
      expect(() => db.exec(sql), sql).toThrow(/AGENT_CATALOG_APPEND_ONLY|CATALOG_EVOLUTION_POSITION_CONFLICT/);
  } finally { db.close(); }
});
it('the v70 → v69 down step is exact for a ledger without suggestions; negative: an existing suggestions table at v69 is refused, never adopted', async () => {
  const f = await ledger(), db = new DatabaseSync(f.path);
  try {
    db.exec(DOWNGRADE_TO_V69_LEDGER_SQL); expect(tables(db)).toEqual([]);
    db.exec('CREATE TABLE catalog_suggestions(x)');
    db.exec('BEGIN IMMEDIATE'); expect(() => migrateLedger(db, 'allow')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' })); db.exec('ROLLBACK');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(69);
    db.exec(DOWNGRADE_TO_V68_LEDGER_SQL); migrateLedger(db, 'allow');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(70); expect(tables(db)).toEqual(TABLES);
  } finally { db.close(); }
});
