import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteLedger, migrateLedger, CURRENT_LEDGER_VERSION, MEMORY_AUTOMATION_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteMemoryJournalStore, upgradeExistingProductLedger } from '#adapters/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { DOWNGRADE_TO_V64_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

// S4B-1 (S4B-DESIGN §12; lane v65 after s7's v64, the lead renumbers at landing): the one memory-automation migration for S4B-1..S4B-7 — support
// rows, extraction receipts and cursor, evaluation records, contests, purge records — plus the tombstone-only rewrite of a revision row (§6.6).
// No earlier row is read or rewritten; an older build refuses v65 (alpha.53/54 meet it as a newer ledger; restore the pre-switch backup).
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const TABLES = ['memory_contests', 'memory_entry_support', 'memory_evaluations', 'memory_extraction_cursors', 'memory_extraction_receipts', 'memory_purges'];
const tables = (db: DatabaseSync) => db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN(${TABLES.map(() => '?').join(',')}) ORDER BY name`).all(...TABLES).map(row => row['name']);
async function v64() {
  const root = await mkdtemp(join(tmpdir(), 'dn-memory-v65-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups);
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_V64_LEDGER_SQL); db.close();
  return { path, backups };
}
const sealed = (value: unknown) => JSON.stringify({ value, keyId: 'k', mac: 'm' });
const entry = { scopeId: 's', entryId: 'e1', revision: 1, content: { kind: 'fact', title: 't', body: 'b', tags: [], lesson: null } };

describe('ledger v65 memory automation migration', () => {
  it('pins the step: v65 is the memory automation step and the current ledger', () => {
    expect(MEMORY_AUTOMATION_LEDGER_VERSION).toBe(65); expect(CURRENT_LEDGER_VERSION).toBe(66);
  });
  it('backs up a v64 ledger and adds only the empty memory automation tables', async () => {
    const f = await v64();
    expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
    const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-23T00:00:00Z'));
    expect(upgrade).toMatchObject({ from: 64, to: 66 });
    const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true }), db = new DatabaseSync(f.path, { readOnly: true });
    try {
      expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(64); expect(tables(backup)).toEqual([]);
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(66); expect(tables(db)).toEqual(TABLES);
      for (const table of TABLES) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']).toBe(0);
    } finally { backup.close(); db.close(); }
  });
  it('N27 (store half): a revision row accepts only its own tombstone rewrite; every other UPDATE and every DELETE still aborts', async () => {
    const f = await v64(); const db = new DatabaseSync(f.path);
    try {
      migrateLedger(db, 'allow');
      db.prepare("INSERT INTO memory_entries(scope_id,entry_id,revision,state,seq,record) VALUES('s','e1',1,'candidate',1,?)").run(sealed(entry));
      db.prepare("INSERT INTO memory_entry_revisions(scope_id,entry_id,revision,record) VALUES('s','e1',1,?)").run(sealed(entry));
      const tombstone = sealed({ ...entry, content: { purged: true, contentDigest: 'a'.repeat(64), digestKind: 'keyed', purgeRecordId: 'p1', reasonCode: 'owner-request' } });
      expect(() => db.prepare("UPDATE memory_entry_revisions SET record=? WHERE scope_id='s'").run(sealed({ ...entry, content: { ...entry.content, body: 'changed' } }))).toThrow(/MEMORY_APPEND_ONLY/);
      expect(() => db.prepare("UPDATE memory_entry_revisions SET revision=2, record=? WHERE scope_id='s'").run(tombstone)).toThrow(/MEMORY_APPEND_ONLY/);
      expect(() => db.prepare("UPDATE memory_entry_revisions SET entry_id='e2', record=? WHERE scope_id='s'").run(tombstone)).toThrow(/MEMORY_APPEND_ONLY|FOREIGN KEY/);
      db.prepare("UPDATE memory_entry_revisions SET record=? WHERE scope_id='s' AND entry_id='e1' AND revision=1").run(tombstone);
      // A tombstone is final: it is never rewritten again (a purge replay skips it), and rows are never deleted.
      expect(() => db.prepare("UPDATE memory_entry_revisions SET record=? WHERE scope_id='s'").run(tombstone)).toThrow(/MEMORY_APPEND_ONLY/);
      expect(() => db.exec('DELETE FROM memory_entry_revisions')).toThrow(/MEMORY_APPEND_ONLY/);
      expect(() => db.exec('DELETE FROM memory_entries')).toThrow(/MEMORY_APPEND_ONLY/);
    } finally { db.close(); }
  });
  it('support, receipts, evaluations and purges are append-only; a contest is resolved exactly once', async () => {
    const f = await v64(); const db = new DatabaseSync(f.path);
    try {
      migrateLedger(db, 'allow');
      db.prepare("INSERT INTO memory_entries(scope_id,entry_id,revision,state,seq,record) VALUES('s','e1',1,'candidate',1,'{}')").run();
      db.exec(`INSERT INTO memory_entry_support(scope_id,entry_id,support_id,seq,record) VALUES('s','e1','c1',1,'{}');
        INSERT INTO memory_extraction_receipts(scope_id,run_id,task_id,attempt_id,at_ms,proposed,record) VALUES('s','r','t','a',1,1,'{}');
        INSERT INTO memory_evaluations(scope_id,record_id,entry_id,seq,record) VALUES('s','v1','e1',1,'{}');
        INSERT INTO memory_purges(scope_id,purge_id,entry_id,content_digest,record) VALUES('s','p1','e1','${'a'.repeat(64)}','{}');
        INSERT INTO memory_contests(scope_id,contest_id,entry_id,opened_at_ms,record) VALUES('s','k1','e1',1,'{}');`);
      for (const table of ['memory_entry_support', 'memory_extraction_receipts', 'memory_evaluations', 'memory_purges'])
        for (const sql of [`UPDATE ${table} SET record='x'`, `DELETE FROM ${table}`]) expect(() => db.exec(sql)).toThrow(/MEMORY_APPEND_ONLY/);
      expect(() => db.exec("UPDATE memory_contests SET record='x'")).toThrow(/MEMORY_APPEND_ONLY/);
      expect(() => db.exec('DELETE FROM memory_contests')).toThrow(/MEMORY_APPEND_ONLY/);
      db.exec("UPDATE memory_contests SET resolution='{}' WHERE contest_id='k1'");
      expect(() => db.exec("UPDATE memory_contests SET resolution='{\"other\":1}' WHERE contest_id='k1'")).toThrow(/MEMORY_APPEND_ONLY/);
      expect(() => db.exec("INSERT INTO memory_extraction_receipts(scope_id,run_id,task_id,attempt_id,at_ms,proposed,record) VALUES('s','r','t','a',2,0,'{}')")).toThrow();
      // The cursor is the one mutable row (one per scope).
      db.exec("INSERT INTO memory_extraction_cursors(scope_id,record) VALUES('s','{}'); UPDATE memory_extraction_cursors SET record='{\"after\":1}' WHERE scope_id='s'");
    } finally { db.close(); }
  });
  it('the store round-trips sealed support rows, extraction receipts, counts and cursor; a tampered row is corruption', async () => {
    const f = await v64(); openSqliteLedger(f.path, options).close();
    const integrity = createHmacIntegrity('memory-key', randomBytes(32)), store = openSqliteMemoryJournalStore(f.path, options, integrity, 'write');
    try {
      const db = new DatabaseSync(f.path); db.prepare("INSERT INTO memory_entries(scope_id,entry_id,revision,state,seq,record) VALUES('s','e1',1,'candidate',1,'{}')").run(); db.close();
      const support = { schemaVersion: 1 as const, scopeId: 's', entryId: 'e1', supportId: 'c1', producer: 'rule' as const, source: { runId: 'r', taskId: 't', attemptId: 'a' },
        ruleId: 'E1', ruleVersion: 1, evaluationId: 'ev', evaluationDigest: 'e'.repeat(64), reportDigest: null, atMs: 5 };
      expect(await store.appendSupport!(support)).toEqual({ replayed: false });
      expect(await store.appendSupport!(support)).toEqual({ replayed: true });
      expect(await store.listSupport!('s', 'e1', 8)).toEqual([support]);
      expect(await store.listSupport!('other', 'e1', 8)).toEqual([]);
      const receipt = { schemaVersion: 1 as const, scopeId: 's', source: { runId: 'r', taskId: 't', attemptId: 'a' }, atMs: 10, proposed: 2, shadow: 0, mode: 'live' as const,
        refused: [], registryRevision: 'memory-automation-core-1' };
      expect(await store.recordExtraction!(receipt)).toEqual({ replayed: false });
      expect(await store.extractionReceipt!('s', receipt.source)).toEqual(receipt);
      expect(await store.extractionCounts!('s', 'r', 0)).toEqual({ run: 2, scope: 2 });
      expect(await store.extractionCounts!('s', 'r', 11)).toEqual({ run: 2, scope: 0 });
      expect(await store.extractionCursor!('s')).toBeNull();
      await store.advanceCursor!('s', 'cursor-1'); expect(await store.extractionCursor!('s')).toBe('cursor-1');
      expect(await store.findTombstone!('s', 'a'.repeat(64))).toBe(false);
      const raw = new DatabaseSync(f.path); raw.exec("DROP TRIGGER memory_entry_support_no_update; UPDATE memory_entry_support SET record=replace(record,'E1','E2')"); raw.close();
      await expect(store.listSupport!('s', 'e1', 8)).rejects.toMatchObject({ code: 'MEMORY_CORRUPT' });
    } finally { store.close(); }
  });
  it('the v65 → v64 down step is exact for a ledger without automation rows, and the upgrade replays to the same tables', async () => {
    const f = await v64(); const db = new DatabaseSync(f.path);
    try {
      migrateLedger(db, 'allow'); expect(tables(db)).toEqual(TABLES);
      db.exec(DOWNGRADE_TO_V64_LEDGER_SQL); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(64); expect(tables(db)).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='memory_entry_revisions_no_update'").get()).toBeDefined();
      migrateLedger(db, 'allow'); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(66); expect(tables(db)).toEqual(TABLES);
    } finally { db.close(); }
  });
  it('negative: the step never adopts an existing table, and a build refuses a ledger newer than its own', async () => {
    const f = await v64(); const db = new DatabaseSync(f.path);
    try {
      db.exec('CREATE TABLE memory_purges(x)');
      db.exec('BEGIN IMMEDIATE'); expect(() => migrateLedger(db, 'allow')).toThrow(); db.exec('ROLLBACK');
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(64);
      db.exec(`DROP TABLE memory_purges; PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1};`);
    } finally { db.close(); }
    expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  });
});
