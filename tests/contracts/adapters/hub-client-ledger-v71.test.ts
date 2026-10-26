import { DatabaseSync } from 'node:sqlite';
import { rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { migrateLedger, CURRENT_LEDGER_VERSION, HUB_CLIENT_LEDGER_VERSION, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { AgentCatalogApplication } from '#engine/core/agent-catalog/index.js';
import { fixture, install, options, source } from '../../fixtures/hub-client.js';
import { DOWNGRADE_TO_V70_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
import { requireLedgerVersion as oldReader } from '../../fixtures/hub-v70-reader.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('v70 migration preserves exact existing v1 skill bytes; new reader reads both versions, old reader refuses v71', async () => {
  const f = await fixture(); roots.push(f.root);
  await new AgentCatalogApplication(f.catalog).defineSkill({ schemaVersion: 1, scopeId: 's', commandId: 'local', skillId: 'local', expectedRevision: null, content: { name: 'Local', text: 'Keep this text.' } });
  const db = new DatabaseSync(f.path);
  try {
    db.exec(DOWNGRADE_TO_V70_LEDGER_SQL);
    expect(oldReader(db, 64)).toBe(70);
    const before = db.prepare("SELECT record FROM skill_definitions WHERE skill_id='local'").get()!['record'];
    db.exec('BEGIN IMMEDIATE'); migrateLedger(db, 'allow'); db.exec('COMMIT');
    // Later migrations (v72 budget period, alpha.56 BP) stack on top; v71 is this slice's own step.
    expect(HUB_CLIENT_LEDGER_VERSION).toBe(71); expect(CURRENT_LEDGER_VERSION).toBeGreaterThanOrEqual(71);
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(CURRENT_LEDGER_VERSION);
    expect(db.prepare("SELECT record FROM skill_definitions WHERE skill_id='local'").get()!['record']).toBe(before);
    expect(() => oldReader(db, 64)).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  } finally { db.close(); }
  await f.app.addSource(source); await f.app.installFile(install());
  const store = await f.deps.openStore('read'); try {
    expect((await store.loadSkill('s', 'local'))!.schemaVersion).toBe(1);
    expect((await store.loadSkill('s', 'invoice'))!.schemaVersion).toBe(2);
  } finally { store.close(); }
});
it('refuses conflicting pre-existing Hub tables and rolls back the entire migration', async () => {
  const f = await fixture(); roots.push(f.root); const db = new DatabaseSync(f.path);
  try {
    db.exec(DOWNGRADE_TO_V70_LEDGER_SQL); db.exec('CREATE TABLE hub_installs(foreign_data TEXT)');
    db.exec('BEGIN IMMEDIATE'); expect(() => migrateLedger(db, 'allow')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' })); db.exec('ROLLBACK');
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(70);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='hub_sources'").get()).toBeUndefined();
    expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow();
  } finally { db.close(); }
});
it('Hub receipts are immutable, feed sequence and source/install revisions move forward, rows cannot be deleted', async () => {
  const f = await fixture(); roots.push(f.root); await f.app.addSource(source); await f.app.installFile(install());
  const db = new DatabaseSync(f.path);
  try {
    for (const table of ['hub_sources', 'hub_installs', 'hub_revocation_snapshots', 'hub_client_receipts']) expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/HUB_APPEND_ONLY/);
    expect(() => db.exec("UPDATE hub_client_receipts SET record='{}'")).toThrow(/HUB_APPEND_ONLY/);
    expect(() => db.exec('UPDATE hub_revocation_snapshots SET sequence=sequence')).toThrow(/HUB_APPEND_ONLY/);
    expect(() => db.exec('UPDATE hub_sources SET revision=revision')).toThrow(/HUB_APPEND_ONLY/);
    expect(() => db.exec('UPDATE hub_installs SET revision=revision')).toThrow(/HUB_APPEND_ONLY/);
  } finally { db.close(); }
});
