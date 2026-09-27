import type { DatabaseSync } from 'node:sqlite';
import { auditCounterSchema, auditRecordSchema, AuditError, encodeCommandProjection, identitySchema, type AuditCounter, type AuditEvent, type AuditRecord } from '#domain/index.js';
import type { AuditStore } from '#engine/index.js';

/**
 * SQLite audit store on the shared ledger (v41). `audit_events` is append-only in the database itself (UPDATE/DELETE triggers
 * abort); every row is cross-checked against its sealed record on read, the way approval rows are. Callers may supply the
 * connection of a larger transaction (an agent turn's) so the audit write commits with the decision it records.
 */
export class SqliteAuditStore implements AuditStore {
  constructor(private readonly db: DatabaseSync) {}
  private transaction<T>(work: () => T): T {
    const owned = !this.db.isTransaction;
    if (owned) this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); if (owned) this.db.exec('COMMIT'); return value; }
    catch (error) { if (owned) { try { this.db.exec('ROLLBACK'); } catch { /* connection lost: nothing committed */ } } throw error; }
  }
  private guard<T>(work: () => T): T {
    try { return work(); }
    catch (error) { if (error instanceof AuditError) throw error; throw new AuditError('AUDIT_UNAVAILABLE'); }
  }
  /** Decodes a row into its sealed record and refuses any row column that disagrees with the record. Seals are verified by the application. */
  private decode(row: Record<string, unknown>): AuditRecord {
    let record: AuditRecord;
    try { record = auditRecordSchema.parse(JSON.parse(String(row['record']))); } catch { throw new AuditError('AUDIT_INTEGRITY'); }
    if (record.event.scopeId !== row['scope_id'] || record.sequence !== row['sequence'] || record.event.eventId !== row['event_id']
      || record.event.subject.kind !== row['kind'] || record.event.atMs !== row['at_ms'] || record.keyId !== row['key_id'] || record.mac !== row['mac']) {
      throw new AuditError('AUDIT_INTEGRITY');
    }
    return record;
  }
  append(event: AuditEvent, seal: (sequence: number) => AuditRecord): AuditRecord {
    return this.guard(() => this.transaction(() => {
      const existing = this.db.prepare('SELECT scope_id,sequence,event_id,kind,at_ms,key_id,mac,record FROM audit_events WHERE scope_id=? AND event_id=?')
        .get(event.scopeId, event.eventId) as Record<string, unknown> | undefined;
      if (existing) {
        const record = this.decode(existing);
        if (encodeCommandProjection('audit-event:1', record.event) !== encodeCommandProjection('audit-event:1', event)) throw new AuditError('AUDIT_CONFLICT');
        return record;
      }
      const last = this.db.prepare('SELECT coalesce(max(sequence),0) AS last FROM audit_events WHERE scope_id=?').get(event.scopeId)?.last;
      const record = seal(Number(last) + 1);
      this.db.prepare('INSERT INTO audit_events(scope_id,sequence,event_id,kind,at_ms,key_id,mac,record) VALUES(?,?,?,?,?,?,?,?)')
        .run(record.event.scopeId, record.sequence, record.event.eventId, record.event.subject.kind, record.event.atMs, record.keyId, record.mac, JSON.stringify(record));
      return record;
    }));
  }
  page(scopeId: string, afterSequence: number, limit: number): readonly AuditRecord[] {
    if (!identitySchema.safeParse(scopeId).success || !Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new AuditError('AUDIT_INVALID');
    return this.guard(() => Object.freeze(this.db.prepare('SELECT scope_id,sequence,event_id,kind,at_ms,key_id,mac,record FROM audit_events WHERE scope_id=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(scopeId, afterSequence, limit).map(row => this.decode(row as Record<string, unknown>))));
  }
  increment(scopeId: string, counter: string, by: number, atMs: number): AuditCounter {
    if (!identitySchema.safeParse(scopeId).success || !identitySchema.safeParse(counter).success || !Number.isSafeInteger(by) || by < 1
      || !Number.isSafeInteger(atMs) || atMs < 0) throw new AuditError('AUDIT_INVALID');
    return this.guard(() => this.transaction(() => {
      this.db.prepare(`INSERT INTO audit_counters(scope_id,counter,count,updated_at_ms) VALUES(?,?,?,?)
        ON CONFLICT(scope_id,counter) DO UPDATE SET count=count+excluded.count,updated_at_ms=max(updated_at_ms,excluded.updated_at_ms)`).run(scopeId, counter, by, atMs);
      const row = this.db.prepare('SELECT scope_id,counter,count,updated_at_ms FROM audit_counters WHERE scope_id=? AND counter=?').get(scopeId, counter);
      return auditCounterSchema.parse({ scopeId: row?.scope_id, counter: row?.counter, count: row?.count, updatedAtMs: row?.updated_at_ms });
    }));
  }
  counters(scopeId: string): readonly AuditCounter[] {
    if (!identitySchema.safeParse(scopeId).success) throw new AuditError('AUDIT_INVALID');
    return this.guard(() => Object.freeze(this.db.prepare('SELECT scope_id,counter,count,updated_at_ms FROM audit_counters WHERE scope_id=? ORDER BY counter').all(scopeId)
      .map(row => auditCounterSchema.parse({ scopeId: row.scope_id, counter: row.counter, count: row.count, updatedAtMs: row.updated_at_ms }))));
  }
  close() { this.db.close(); }
}
