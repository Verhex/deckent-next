import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { encodeCommandProjection, memoryEntrySchema, memoryIndexText, type MemoryEntry, type MemoryState } from '#domain/index.js';
import { AuditApplication, MemoryJournalError, type MemoryChange, type MemoryJournalStore, type MemoryReceipt } from '#engine/index.js';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { openSqliteLedger, requireLedgerVersion, MEMORY_JOURNAL_LEDGER_VERSION, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import type { IntegrityAuthority } from '#platform/index.js';

const SEAL = 'memory-journal-store:1';
const corrupt = () => new MemoryJournalError('MEMORY_CORRUPT');
/**
 * Core SQLite adapter of the DB-neutral memory journal port, on the shared ledger (lane v60). Every row is sealed with the installation integrity
 * key and cross-checked against its columns on read. The FTS5 table indexes the domain-folded text (`memoryIndexText`) under the entry's explicit `id` (stable across VACUUM);
 * it is a derived index, never the record: hits are re-read and re-verified from `memory_entries` by the engine.
 */
class SqliteMemoryJournalStore implements MemoryJournalStore {
  readonly capabilities = Object.freeze({ fullTextSearch: true });
  private readonly audit: AuditApplication;
  constructor(private readonly db: DatabaseSync, private readonly integrity: IntegrityAuthority) { this.audit = new AuditApplication(new SqliteAuditStore(db), integrity); }
  private seal(value: unknown) { return JSON.stringify({ value, keyId: this.integrity.keyId, mac: this.integrity.sign(encodeCommandProjection(SEAL, value)) }); }
  private open(input: unknown): unknown {
    try {
      const sealed = JSON.parse(String(input)) as { value: unknown; mac: string; keyId: string };
      if (this.integrity.verify(encodeCommandProjection(SEAL, sealed.value), sealed.mac, sealed.keyId)) return sealed.value;
    } catch { /* fall through */ }
    throw corrupt();
  }
  private entry(row: Record<string, unknown> | undefined, scopeId: string, entryId?: string): MemoryEntry {
    const parsed = memoryEntrySchema.safeParse(this.open(row?.['record']));
    if (!parsed.success || parsed.data.scopeId !== scopeId || parsed.data.entryId !== (entryId ?? row?.['entry_id']) || parsed.data.revision !== row?.['revision']
      || ('state' in row! && parsed.data.state !== row['state'])) throw corrupt();
    return parsed.data;
  }
  private read<T>(work: () => T): T { try { return work(); } catch (error) { throw error instanceof MemoryJournalError ? error : new MemoryJournalError('MEMORY_UNAVAILABLE'); } }
  private current(scopeId: string, entryId: string) {
    const row = this.db.prepare('SELECT id,entry_id,revision,state,record FROM memory_entries WHERE scope_id=? AND entry_id=?').get(scopeId, entryId);
    return row ? { id: Number(row['id']), entry: this.entry(row, scopeId, entryId) } : null;
  }
  async load(scopeId: string, entryId: string) { return this.read(() => this.current(scopeId, entryId)?.entry ?? null); }
  private revision(scopeId: string, entryId: string, revision: number) {
    const row = this.db.prepare('SELECT entry_id,revision,record FROM memory_entry_revisions WHERE scope_id=? AND entry_id=? AND revision=?').get(scopeId, entryId, revision);
    return row ? this.entry(row, scopeId, entryId) : null;
  }
  async loadRevision(scopeId: string, entryId: string, revision: number) { return this.read(() => this.revision(scopeId, entryId, revision)); }
  async history(scopeId: string, entryId: string, limit: number) {
    return this.read(() => this.db.prepare('SELECT entry_id,revision,record FROM memory_entry_revisions WHERE scope_id=? AND entry_id=? ORDER BY revision DESC LIMIT ?')
      .all(scopeId, entryId, limit).map(row => this.entry(row, scopeId, entryId)).reverse());
  }
  async list(scopeId: string, states: readonly MemoryState[], limit: number) {
    return this.read(() => this.db.prepare(`SELECT entry_id,revision,state,record FROM memory_entries WHERE scope_id=? AND state IN(${states.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT ?`)
      .all(scopeId, ...states, limit).map(row => this.entry(row, scopeId)));
  }
  /** Terms are already folded words (letters/digits only); each is quoted, so no FTS5 operator or column filter can reach MATCH. */
  async search(scopeId: string, terms: readonly string[], states: readonly MemoryState[], limit: number) {
    return this.read(() => this.db.prepare(`SELECT e.entry_id FROM memory_search s JOIN memory_entries e ON e.id=s.rowid WHERE memory_search MATCH ? AND e.scope_id=?
      AND e.state IN(${states.map(() => '?').join(',')}) ORDER BY bm25(memory_search) LIMIT ?`)
      .all(terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' '), scopeId, ...states, limit).map(row => String(row['entry_id'])));
  }
  private loadReceipt(scopeId: string, commandId: string): MemoryReceipt | null {
    const row = this.db.prepare('SELECT entry_id,revision,record FROM memory_command_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (!row) return null;
    const receipt = this.open(row['record']) as MemoryReceipt;
    if (receipt.scopeId !== scopeId || receipt.commandId !== commandId || receipt.entryId !== row['entry_id'] || receipt.revision !== row['revision']) throw corrupt();
    return receipt;
  }
  async receipt(scopeId: string, commandId: string) { return this.read(() => this.loadReceipt(scopeId, commandId)); }
  async commit(change: MemoryChange) {
    const next = memoryEntrySchema.parse(change.next), { receipt } = change;
    if (next.revision !== (change.previous?.revision ?? 0) + 1 || next.scopeId !== receipt.scopeId || next.entryId !== receipt.entryId || next.revision !== receipt.revision) throw corrupt();
    return this.read(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try { const result = this.apply(next, change); try { this.db.exec('COMMIT'); } catch { throw new MemoryJournalError('MEMORY_OUTCOME_UNKNOWN'); } return result; } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* A lost commit result is resolved by the same command receipt on retry. */ } throw error; }
    });
  }
  private apply(next: MemoryEntry, change: MemoryChange) {
    const { receipt } = change, prior = this.loadReceipt(receipt.scopeId, receipt.commandId);
    if (prior) {
      const entry = prior.digest === receipt.digest ? this.revision(prior.scopeId, prior.entryId, prior.revision) : null;
      if (!entry) throw new MemoryJournalError('MEMORY_COMMAND_CONFLICT'); return { replayed: true, entry };
    }
    const current = this.current(next.scopeId, next.entryId);
    if (!isDeepStrictEqual(current?.entry ?? null, change.previous)) throw new MemoryJournalError('MEMORY_REVISION_CONFLICT');
    this.audit.record(change.event);
    const seq = Number(this.db.prepare('SELECT coalesce(max(seq),0)+1 AS seq FROM memory_entries WHERE scope_id=?').get(next.scopeId)?.['seq']), record = this.seal(next);
    let id = current?.id;
    if (current) this.db.prepare('UPDATE memory_entries SET revision=?,state=?,seq=?,record=? WHERE scope_id=? AND entry_id=? AND revision=?')
      .run(next.revision, next.state, seq, record, next.scopeId, next.entryId, current.entry.revision);
    else id = Number(this.db.prepare('INSERT INTO memory_entries(scope_id,entry_id,revision,state,seq,record) VALUES(?,?,?,?,?,?)')
      .run(next.scopeId, next.entryId, next.revision, next.state, seq, record).lastInsertRowid);
    this.db.prepare('INSERT INTO memory_entry_revisions(scope_id,entry_id,revision,record) VALUES(?,?,?,?)').run(next.scopeId, next.entryId, next.revision, record);
    this.db.prepare('INSERT INTO memory_command_receipts(scope_id,command_id,entry_id,revision,record) VALUES(?,?,?,?,?)')
      .run(receipt.scopeId, receipt.commandId, receipt.entryId, receipt.revision, this.seal(receipt));
    this.db.prepare('DELETE FROM memory_search WHERE rowid=?').run(id!); this.db.prepare('INSERT INTO memory_search(rowid,text) VALUES(?,?)').run(id!, memoryIndexText(next));
    return { replayed: false, entry: next };
  }
  close() { this.db.close(); }
}

/** `write` opens the current ledger without migrating (the service owns backed-up upgrades); `read` opens it read-only and requires the journal version. */
export function openSqliteMemoryJournalStore(path: string, options: SqliteLedgerOptions, integrity: IntegrityAuthority, access: 'read' | 'write'): MemoryJournalStore {
  if (access === 'write') return new SqliteMemoryJournalStore(openSqliteLedger(path, options, 'forbid'), integrity);
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new NativeDatabase(path, { readOnly: true, timeout: options.busyTimeoutMs });
  try { requireLedgerVersion(db, MEMORY_JOURNAL_LEDGER_VERSION); return new SqliteMemoryJournalStore(db, integrity); } catch (error) { db.close(); throw error; }
}
