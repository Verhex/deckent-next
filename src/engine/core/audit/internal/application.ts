import { auditEventSchema, AUDIT_SEQUENCE_STEP, AuditError, type AuditCounter, type AuditEvent, type AuditRecord } from '#domain/index.js';
import type { IntegrityAuthority } from '#platform/index.js';
import { sealAuditRecord, verifyAuditRecord } from './integrity.js';
import { AuditCheckpoints } from './checkpoint.js';
import { auditCheckpointPolicySchema } from './checkpoint-policy.js';
import type { AuditStore } from './store.js';
const MAX_PAGE = 1_000;
/**
 * The one writer and reader of Core audit events. Contract "no audit, no effect": `record` returns the sealed record only after
 * the store persisted it; every failure is a typed `AuditError` the caller must treat as "do not apply the effect". Time is the
 * caller's trusted clock (`event.atMs`, `atMs`); this component never reads the wall clock.
 */
export class AuditApplication {
  private readonly checkpoints: AuditCheckpoints;
  constructor(private readonly store: AuditStore, private readonly integrity: IntegrityAuthority, checkpointPolicy?: unknown) {
    const parsed = auditCheckpointPolicySchema.safeParse(checkpointPolicy ?? {});
    if (!parsed.success) throw new AuditError('AUDIT_INVALID');
    this.checkpoints = new AuditCheckpoints(store, integrity, parsed.data);
  }
  verifyCheckpoints(command: import('#domain/index.js').AuditCheckpointVerifyCommand) {
    return this.guard(() => this.checkpoints.verify(command));
  }
  private guard<T>(work: () => T): T {
    try { return work(); }
    catch (error) { if (error instanceof AuditError) throw error; throw new AuditError('AUDIT_UNAVAILABLE'); }
  }
  record(input: unknown): AuditRecord {
    const parsed = auditEventSchema.safeParse(input);
    if (!parsed.success) throw new AuditError('AUDIT_INVALID');
    const event: AuditEvent = parsed.data;
    if (event.subject.kind === 'audit-checkpoint') throw new AuditError('AUDIT_INVALID');
    return this.guard(() => verifyAuditRecord(this.store.append(event, sequence => sealAuditRecord(event, sequence, this.integrity), record => this.checkpoints.afterRecord(verifyAuditRecord(record, this.integrity))), this.integrity));
  }
  /** Verified page of one scope: every record's seal, and the sequence continuity a deleted row would break. */
  list(scopeId: string, afterSequence: number, limit: number): readonly AuditRecord[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < AUDIT_SEQUENCE_STEP || limit > MAX_PAGE) throw new AuditError('AUDIT_INVALID');
    const page = this.guard(() => this.store.page(scopeId, afterSequence, limit));
    let expected = afterSequence + AUDIT_SEQUENCE_STEP;
    return Object.freeze(page.map(row => {
      const record = verifyAuditRecord(row, this.integrity);
      if (record.event.scopeId !== scopeId || record.sequence !== expected) throw new AuditError('AUDIT_INTEGRITY');
      expected++; return record;
    }));
  }
  count(scopeId: string, counter: string, by: number, atMs: number): AuditCounter {
    if (!Number.isSafeInteger(by) || by < AUDIT_SEQUENCE_STEP || !Number.isSafeInteger(atMs) || atMs < 0) throw new AuditError('AUDIT_INVALID');
    return this.guard(() => this.store.increment(scopeId, counter, by, atMs));
  }
  counters(scopeId: string): readonly AuditCounter[] { return this.guard(() => this.store.counters(scopeId)); }
}
