import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteLedger, CURRENT_LEDGER_VERSION, MEMORY_JOURNAL_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteMemoryJournalStore, upgradeExistingProductLedger } from '#adapters/index.js';
import { MemoryJournalApplication } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { DOWNGRADE_TO_V60_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

// S4 memory journal v1 on the Core SQLite adapter: additive ledger step v61 (after S0's v60), sealed rows, append-only
// revisions and receipts, FTS5 index over the domain-folded text, scope-filtered in SQL and re-checked above the port.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('memory-key', randomBytes(32));
const human = { id: 'h', issuer: 'local-os', subject: 'uid:1000', assurance: 'os-user' as const, scopeIds: ['s', 'other'] };
async function ledger() { const root = await mkdtemp(join(tmpdir(), 'dn-memory-v61-')); roots.push(root); const path = join(root, 'ledger.db'), backups = join(root, 'backups');
  await mkdir(backups); openSqliteLedger(path, options).close(); return { path, backups }; }
function app(path: string, key = integrity) {
  return new MemoryJournalApplication({ verifier: { verify: async () => human }, authorize: async () => ({ revision: 'p', ruleId: 'r' }),
    openStore: async access => openSqliteMemoryJournalStore(path, options, key, access), now: () => 1_000, eventId: () => `e${Math.random()}` });
}
const content = (title: string) => ({ kind: 'fact', title, body: 'İrsaliyesiz fatura onaya düşer; sipariş eşleştirme zorunlu.', tags: ['erp'], lesson: null });
const propose = (commandId: string, scopeId: string, title = 'Fatura eşleştirme İstanbul') => ({ schemaVersion: 1, commandId, scopeId, content: content(title), origin: { kind: 'human', ref: null } });

describe('ledger v61 memory journal migration', () => {
  it('pins the version: v61 is the memory journal step', () => {
    expect(MEMORY_JOURNAL_LEDGER_VERSION).toBe(61); expect(CURRENT_LEDGER_VERSION).toBe(63);
  });
  it('backs up v60 and adds only the memory tables; an older reader refuses the upgraded ledger', async () => {
    const f = await ledger(); const db = new DatabaseSync(f.path); db.exec(DOWNGRADE_TO_V60_LEDGER_SQL); db.close();
    expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
    const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-23T00:00:00Z'));
    expect(upgrade).toMatchObject({ from: 60, to: CURRENT_LEDGER_VERSION });
    const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true }), current = new DatabaseSync(f.path, { readOnly: true });
    try {
      expect(backup.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'memory%'").all()).toEqual([]);
      expect(current.prepare("SELECT name FROM sqlite_master WHERE type IN('table','trigger','index') AND name LIKE 'memory%' AND name NOT LIKE 'memory_search_%' ORDER BY name").all()
        .map(row => row.name)).toEqual(['memory_command_receipts', 'memory_command_receipts_no_delete', 'memory_command_receipts_no_update', 'memory_entries',
        'memory_entries_no_delete', 'memory_entries_recent', 'memory_entry_revisions', 'memory_entry_revisions_no_delete', 'memory_entry_revisions_no_update', 'memory_search']);
    } finally { backup.close(); current.close(); }
  });
  it('refuses a v60 ledger holding a foreign same-name table and rolls the version back', async () => {
    const f = await ledger(); const db = new DatabaseSync(f.path); db.exec(DOWNGRADE_TO_V60_LEDGER_SQL); db.exec('CREATE TABLE memory_entries(x TEXT)'); db.close();
    await expect(upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-23T00:00:00Z'))).rejects.toThrow();
    const check = new DatabaseSync(f.path, { readOnly: true });
    try { expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(60); expect(check.prepare("SELECT name FROM sqlite_master WHERE name='memory_search'").all()).toEqual([]); }
    finally { check.close(); }
  });
});

describe('SQLite memory journal store', () => {
  it('writes sealed revisions with receipts and an audit event, and finds entries by folded full-text words within the scope only', async () => {
    const f = await ledger(), memory = app(f.path);
    await memory.propose(propose('m1', 's')); await memory.propose(propose('m2', 'other'));
    await memory.verify({ schemaVersion: 1, commandId: 'v1', scopeId: 's', entryId: 'm1', expectedRevision: 1, basis: { kind: 'human-review', note: 'ok' } });
    const found = await memory.search({ schemaVersion: 1, scopeId: 's', query: 'ISTANBUL eslestirme', limit: 10 });
    expect(found).toMatchObject({ status: 'ok', method: 'full-text', complete: true });
    expect(found.status === 'ok' && found.entries.map(entry => [entry.scopeId, entry.entryId, entry.state])).toEqual([['s', 'm1', 'verified']]);
    expect(await memory.search({ schemaVersion: 1, scopeId: 's', query: 'fatura', states: ['candidate'], limit: 10 })).toMatchObject({ status: 'ok', entries: [] });
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM memory_entry_revisions').get()?.n).toBe(3);
      expect(db.prepare("SELECT count(*) AS n FROM audit_events WHERE kind='memory-journal'").get()?.n).toBe(3);
    } finally { db.close(); }
    const view = await memory.inspect({ schemaVersion: 1, scopeId: 's', entryId: 'm1' });
    expect(view.status === 'ok' && view.history.map(entry => entry.revision)).toEqual([1, 2]);
  });
  it('revisions, receipts and entries cannot be deleted or rewritten in place', async () => {
    const f = await ledger(); await app(f.path).propose(propose('m1', 's'));
    const db = new DatabaseSync(f.path);
    try {
      expect(() => db.exec('DELETE FROM memory_entries')).toThrow(/MEMORY_APPEND_ONLY/);
      expect(() => db.exec('DELETE FROM memory_entry_revisions')).toThrow(/MEMORY_APPEND_ONLY/);
      expect(() => db.exec("UPDATE memory_entry_revisions SET record='{}'")).toThrow(/MEMORY_APPEND_ONLY/);
      expect(() => db.exec('DELETE FROM memory_command_receipts')).toThrow(/MEMORY_APPEND_ONLY/);
    } finally { db.close(); }
  });
  it('a tampered row or another integrity key holds the read instead of returning an empty or altered memory', async () => {
    const f = await ledger(), memory = app(f.path); await memory.propose(propose('m1', 's'));
    expect(await app(f.path, createHmacIntegrity('memory-key', randomBytes(32))).list({ schemaVersion: 1, scopeId: 's', limit: 10 }))
      .toEqual({ schemaVersion: 1, status: 'held', code: 'MEMORY_CORRUPT' });
    const db = new DatabaseSync(f.path); db.exec("UPDATE memory_entries SET record=replace(record,'Fatura','Fatüra')"); db.close();
    expect(await memory.search({ schemaVersion: 1, scopeId: 's', query: 'fatura', limit: 10 })).toEqual({ schemaVersion: 1, status: 'held', code: 'MEMORY_CORRUPT' });
    expect(await memory.inspect({ schemaVersion: 1, scopeId: 's', entryId: 'm1' })).toEqual({ schemaVersion: 1, status: 'held', code: 'MEMORY_CORRUPT' });
  });
  it('a read on a ledger older than the journal holds (read-only open never migrates)', async () => {
    const f = await ledger(); const db = new DatabaseSync(f.path); db.exec(DOWNGRADE_TO_V60_LEDGER_SQL); db.close();
    expect(await app(f.path).list({ schemaVersion: 1, scopeId: 's', limit: 10 })).toEqual({ schemaVersion: 1, status: 'held', code: 'MEMORY_UNAVAILABLE' });
    const check = new DatabaseSync(f.path, { readOnly: true }); try { expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(60); } finally { check.close(); }
  });
  it('the full-text index survives a VACUUM (the backup path uses VACUUM INTO): hits stay bound to the entries they index', async () => {
    const f = await ledger(), memory = app(f.path);
    await memory.propose(propose('a', 's', 'Birinci kural')); await memory.propose(propose('b', 's', 'İkinci kural')); await memory.propose(propose('c', 's', 'Üçüncü fatura'));
    await memory.retire({ schemaVersion: 1, commandId: 'ra', scopeId: 's', entryId: 'a', expectedRevision: 1, reason: 'old', supersededBy: null });
    const db = new DatabaseSync(f.path); db.exec('VACUUM'); expect(db.prepare("SELECT s.rowid=e.id AS bound FROM memory_search s JOIN memory_entries e ON e.id=s.rowid WHERE e.entry_id='c'").get()?.bound).toBe(1); db.close();
    const found = await memory.search({ schemaVersion: 1, scopeId: 's', query: 'ucuncu', limit: 10 });
    expect(found.status === 'ok' && found.entries.map(entry => entry.entryId)).toEqual(['c']);
  });
  it('list reads newest-changed first through the scope index and stays bounded', async () => {
    const f = await ledger(), memory = app(f.path);
    for (let index = 0; index < 5; index++) await memory.propose(propose(`m${index}`, 's', `Kural ${index}`));
    await memory.retire({ schemaVersion: 1, commandId: 'r', scopeId: 's', entryId: 'm0', expectedRevision: 1, reason: 'old', supersededBy: 'm4' });
    const listed = await memory.list({ schemaVersion: 1, scopeId: 's', limit: 2 });
    expect(listed.status === 'ok' && listed.entries.map(entry => entry.entryId)).toEqual(['m4', 'm3']);
    const all = await memory.list({ schemaVersion: 1, scopeId: 's', states: ['retired'], limit: 10 });
    expect(all.status === 'ok' && all.entries.map(entry => entry.entryId)).toEqual(['m0']);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try { expect(JSON.stringify(db.prepare('EXPLAIN QUERY PLAN SELECT record FROM memory_entries WHERE scope_id=? AND state IN(?,?) ORDER BY seq DESC LIMIT ?').all('s', 'candidate', 'verified', 2))).toContain('memory_entries_recent'); }
    finally { db.close(); }
  });
});
