import { auditEventSchema, AuditError, type AuditCounter, type AuditEvent, type AuditRecord } from '#domain/index.js';
import type { IntegrityAuthority } from '#platform/index.js';
import { sealAuditRecord, verifyAuditRecord } from './integrity.js';
import type { AuditStore } from './store.js';
const MAX_PAGE = 1_000;
/**
 * The one writer and reader of Core audit events. Contract "no audit, no effect": `record` returns the sealed record only after
 * the store persisted it; every failure is a typed `AuditError` the caller must treat as "do not apply the effect". Time is the
 * caller's trusted clock (`event.atMs`, `atMs`); this component never reads the wall clock.
 */
export class AuditApplication {
  constructor(private readonly store: AuditStore, private readonly integrity: IntegrityAuthority) {}
  private guard<T>(work: () => T): T {
    try { return work(); }
    catch (error) { if (error instanceof AuditError) throw error; throw new AuditError('AUDIT_UNAVAILABLE'); }
  }
  record(input: unknown): AuditRecord {
    const parsed = auditEventSchema.safeParse(input);
    if (!parsed.success) throw new AuditError('AUDIT_INVALID');
    const event: AuditEvent = parsed.data;
    return this.guard(() => verifyAuditRecord(this.store.append(event, sequence => sealAuditRecord(event, sequence, this.integrity)), this.integrity));
  }
  /** Verified page of one scope: every record's seal, and the sequence continuity a deleted row would break. */
  list(scopeId: string, afterSequence: number, limit: number): readonly AuditRecord[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new AuditError('AUDIT_INVALID');
    const page = this.guard(() => this.store.page(scopeId, afterSequence, limit));
    let expected = afterSequence + 1;
    return Object.freeze(page.map(row => {
      const record = verifyAuditRecord(row, this.integrity);
      if (record.event.scopeId !== scopeId || record.sequence !== expected) throw new AuditError('AUDIT_INTEGRITY');
      expected++; return record;
    }));
  }
  count(scopeId: string, counter: string, by: number, atMs: number): AuditCounter {
    if (!Number.isSafeInteger(by) || by < 1 || !Number.isSafeInteger(atMs) || atMs < 0) throw new AuditError('AUDIT_INVALID');
    return this.guard(() => this.store.increment(scopeId, counter, by, atMs));
  }
  counters(scopeId: string): readonly AuditCounter[] { return this.guard(() => this.store.counters(scopeId)); }
}
