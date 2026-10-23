import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { encodeCommandProjection, memoryContestSchema, memoryEntrySchema, memoryEvaluationRecordSchema, memoryIndexText, type MemoryContest, type MemoryEntry,
  type MemoryEvaluationRecord, type MemoryState } from '#domain/index.js';
import { AuditApplication, MemoryJournalError, type MemoryChange, type MemoryExtractionReceipt, type MemoryJournalStore, type MemoryReceipt, type MemorySupport } from '#engine/index.js';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { openSqliteLedger, requireLedgerVersion, MEMORY_AUTOMATION_LEDGER_VERSION, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import type { IntegrityAuthority } from '#platform/index.js';

const SEAL = 'memory-journal-store:1';
type AuditEvent = MemoryChange['event'];
const corrupt = () => new MemoryJournalError('MEMORY_CORRUPT');
/**
 * Core SQLite adapter of the DB-neutral memory journal port, on the shared ledger (v61; S4B-1 support, extraction and purge tables at v65). Every row is sealed with the installation integrity
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
  /** S4B-1 (v65): sealed, append-only support rows; a row whose seal or columns disagree is corruption. */
  private supportRow(row: Record<string, unknown>, scopeId: string) {
    const value = this.open(row['record']) as MemorySupport;
    if (value.scopeId !== scopeId || value.entryId !== row['entry_id'] || value.supportId !== row['support_id']) throw corrupt();
    return value;
  }
  async appendSupport(support: MemorySupport) {
    return this.read(() => this.write(() => this.insertSupport(support)));
  }
  private insertSupport(support: MemorySupport) {
    const prior = this.db.prepare('SELECT entry_id,support_id,record FROM memory_entry_support WHERE scope_id=? AND support_id=?').get(support.scopeId, support.supportId);
    if (prior) { if (!isDeepStrictEqual({ ...this.supportRow(prior, support.scopeId), atMs: support.atMs }, support)) throw new MemoryJournalError('MEMORY_COMMAND_CONFLICT'); return { replayed: true }; }
    const seq = Number(this.db.prepare('SELECT coalesce(max(seq),0)+1 AS seq FROM memory_entry_support WHERE scope_id=? AND entry_id=?').get(support.scopeId, support.entryId)?.['seq']);
    this.db.prepare('INSERT INTO memory_entry_support(scope_id,entry_id,support_id,seq,record) VALUES(?,?,?,?,?)').run(support.scopeId, support.entryId, support.supportId, seq, this.seal(support));
    return { replayed: false };
  }
  async listSupport(scopeId: string, entryId: string, limit: number) {
    return this.read(() => this.db.prepare('SELECT entry_id,support_id,record FROM memory_entry_support WHERE scope_id=? AND entry_id=? ORDER BY seq LIMIT ?')
      .all(scopeId, entryId, limit).map(row => this.supportRow(row, scopeId)));
  }
  async findTombstone(scopeId: string, contentDigest: string) {
    return this.read(() => this.db.prepare('SELECT 1 FROM memory_purges WHERE scope_id=? AND content_digest=? LIMIT 1').get(scopeId, contentDigest) !== undefined);
  }
  async extractionReceipt(scopeId: string, source: MemorySupport['source']) {
    return this.read(() => {
      const row = this.db.prepare('SELECT record FROM memory_extraction_receipts WHERE scope_id=? AND run_id=? AND task_id=? AND attempt_id=?').get(scopeId, source.runId, source.taskId, source.attemptId);
      if (!row) return null;
      const value = this.open(row['record']) as MemoryExtractionReceipt;
      if (value.scopeId !== scopeId || !isDeepStrictEqual(value.source, source)) throw corrupt();
      return value;
    });
  }
  async recordExtraction(receipt: MemoryExtractionReceipt) {
    return this.read(() => this.write(() => {
      const { scopeId, source } = receipt;
      if (this.db.prepare('SELECT 1 FROM memory_extraction_receipts WHERE scope_id=? AND run_id=? AND task_id=? AND attempt_id=?').get(scopeId, source.runId, source.taskId, source.attemptId)) return { replayed: true };
      this.db.prepare('INSERT INTO memory_extraction_receipts(scope_id,run_id,task_id,attempt_id,at_ms,proposed,record) VALUES(?,?,?,?,?,?,?)')
        .run(scopeId, source.runId, source.taskId, source.attemptId, receipt.atMs, receipt.proposed, this.seal(receipt));
      return { replayed: false };
    }));
  }
  /** Counts read the indexed columns; the sealed records stay the evidence (an integrity read is the receipt itself). */
  async extractionCounts(scopeId: string, runId: string, sinceMs: number) {
    return this.read(() => {
      const total = (sql: string, ...args: (string | number)[]) => Number(this.db.prepare(sql).get(...args)?.['n'] ?? 0);
      return { run: total('SELECT coalesce(sum(proposed),0) AS n FROM memory_extraction_receipts WHERE scope_id=? AND run_id=?', scopeId, runId),
        scope: total('SELECT coalesce(sum(proposed),0) AS n FROM memory_extraction_receipts WHERE scope_id=? AND at_ms>=?', scopeId, sinceMs) };
    });
  }
  async extractionCursor(scopeId: string) {
    return this.read(() => {
      const row = this.db.prepare('SELECT record FROM memory_extraction_cursors WHERE scope_id=?').get(scopeId);
      if (!row) return null;
      const value = this.open(row['record']) as { scopeId: string; position: string };
      if (value.scopeId !== scopeId || typeof value.position !== 'string') throw corrupt();
      return value.position;
    });
  }
  async advanceCursor(scopeId: string, position: string) {
    this.read(() => this.write(() => this.db.prepare('INSERT INTO memory_extraction_cursors(scope_id,record) VALUES(?,?) ON CONFLICT(scope_id) DO UPDATE SET record=excluded.record')
      .run(scopeId, this.seal({ scopeId, position }))));
  }
  /** S4B-3 (v65 tables): a sealed record with its digest, cross-checked against its columns; anything else is corruption. */
  private evaluation(row: Record<string, unknown>, scopeId: string) {
    const value = this.open(row['record']) as { record: unknown; digest: unknown }, parsed = memoryEvaluationRecordSchema.safeParse(value.record);
    if (!parsed.success || parsed.data.scopeId !== scopeId || parsed.data.recordId !== row['record_id'] || parsed.data.entryId !== row['entry_id'] || typeof value.digest !== 'string') throw corrupt();
    return { record: parsed.data, digest: value.digest };
  }
  async putEvaluation(record: MemoryEvaluationRecord, digest: string, event: AuditEvent) {
    return this.read(() => this.write(() => {
      const prior = this.db.prepare('SELECT record_id,entry_id,record FROM memory_evaluations WHERE scope_id=? AND record_id=?').get(record.scopeId, record.recordId);
      if (prior) { if (this.evaluation(prior, record.scopeId).digest !== digest) throw new MemoryJournalError('MEMORY_COMMAND_CONFLICT'); return { replayed: true }; }
      this.audit.record(event);
      const seq = Number(this.db.prepare('SELECT coalesce(max(seq),0)+1 AS seq FROM memory_evaluations WHERE scope_id=?').get(record.scopeId)?.['seq']);
      this.db.prepare('INSERT INTO memory_evaluations(scope_id,record_id,entry_id,seq,record) VALUES(?,?,?,?,?)').run(record.scopeId, record.recordId, record.entryId, seq, this.seal({ record, digest }));
      return { replayed: false };
    }));
  }
  async loadEvaluation(scopeId: string, recordId: string) {
    return this.read(() => { const row = this.db.prepare('SELECT record_id,entry_id,record FROM memory_evaluations WHERE scope_id=? AND record_id=?').get(scopeId, recordId);
      return row ? this.evaluation(row, scopeId) : null; });
  }
  async recentEvaluations(scopeId: string, limit: number) {
    return this.read(() => this.db.prepare('SELECT record_id,entry_id,record FROM memory_evaluations WHERE scope_id=? ORDER BY seq DESC LIMIT ?').all(scopeId, limit)
      .map(row => this.evaluation(row, scopeId).record));
  }
  async openContest(contest: MemoryContest, event: AuditEvent) {
    const value = memoryContestSchema.parse(contest);
    return this.read(() => this.write(() => {
      const prior = this.db.prepare('SELECT record FROM memory_contests WHERE scope_id=? AND contest_id=?').get(value.scopeId, value.contestId);
      if (prior) { if (!isDeepStrictEqual(this.open(prior['record']), value)) throw new MemoryJournalError('MEMORY_COMMAND_CONFLICT'); return { replayed: true }; }
      this.audit.record(event);
      this.db.prepare('INSERT INTO memory_contests(scope_id,contest_id,entry_id,opened_at_ms,record,resolution) VALUES(?,?,?,?,?,NULL)')
        .run(value.scopeId, value.contestId, value.entryId, value.openedAtMs, this.seal(value));
      return { replayed: false };
    }));
  }
  async contestCount(scopeId: string, sinceMs: number) {
    return this.read(() => Number(this.db.prepare('SELECT count(*) AS n FROM memory_contests WHERE scope_id=? AND opened_at_ms>=?').get(scopeId, sinceMs)?.['n'] ?? 0));
  }
  private write<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); try { this.db.exec('COMMIT'); } catch { throw new MemoryJournalError('MEMORY_OUTCOME_UNKNOWN'); } return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* a lost result is resolved by the same idempotent write on retry */ } throw error; }
  }
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
    if (change.support) this.insertSupport(change.support);
    return { replayed: false, entry: next };
  }
  close() { this.db.close(); }
}

/** `write` opens the current ledger without migrating (the service owns backed-up upgrades); `read` opens it read-only and requires the journal version. */
export function openSqliteMemoryJournalStore(path: string, options: SqliteLedgerOptions, integrity: IntegrityAuthority, access: 'read' | 'write'): MemoryJournalStore {
  if (access === 'write') return new SqliteMemoryJournalStore(openSqliteLedger(path, options, 'forbid'), integrity);
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new NativeDatabase(path, { readOnly: true, timeout: options.busyTimeoutMs });
  try { requireLedgerVersion(db, MEMORY_AUTOMATION_LEDGER_VERSION); return new SqliteMemoryJournalStore(db, integrity); } catch (error) { db.close(); throw error; }
}
/** S4B-1 §4.6 keyed digests: HMAC under the installation integrity key with its own label domain (`memory-purge:1/<label>`), so no content-derived
 * digest or id is a plain hash. The key is the integrity key file itself: backed up and restored with it, never a second unbacked key. */
export const memoryKeyedDigest = (integrity: IntegrityAuthority) => (label: string, value: unknown) => integrity.sign(encodeCommandProjection(`memory-purge:1/${label}`, value));
