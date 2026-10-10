import { AuditError, AUDIT_SEQUENCE_STEP, AUDIT_CHECKPOINT_SCHEMA_VERSION, auditCheckpointVerifyCommandSchema, encodeCommandProjection,
  type AuditCheckpointRecord, type AuditCheckpointSubject, type AuditCheckpointVerifyCommand, type AuditRecord } from '#domain/index.js';
import { sha256, type IntegrityAuthority } from '#platform/index.js';
import { sealAuditRecord, verifyAuditRecord, verifyAuditCheckpointRecord } from './integrity.js';
import type { AuditStore } from './store.js';
import type { AuditCheckpointPolicy } from './checkpoint-policy.js';
export function auditCheckpointDigest(record: AuditRecord): string { return sha256(encodeCommandProjection('audit-checkpoint:1', record)); }
const initialDigest = () => sha256('audit-checkpoint-interval:1');
const addDigest = (previous: string, record: AuditRecord) => sha256(encodeCommandProjection('audit-checkpoint-interval:1', { previous, record }));
export interface AuditCheckpointVerification {
  readonly schemaVersion: 1; readonly scopeId: string; readonly status: 'verified' | 'missing-checkpoint';
  readonly records: number; readonly checkpoints: number; readonly pendingRecords: number;
  readonly latestCheckpoint: AuditCheckpointRecord | null; readonly anchor: { readonly sequence: number; readonly digest: string } | null;
}
/** Owned by AuditApplication, using the same authority as events; no new custody or rotation flow. */
export class AuditCheckpoints {
  constructor(private readonly store: AuditStore, private readonly authority: IntegrityAuthority, private readonly policy: AuditCheckpointPolicy) {}
  private *range(scopeId: string, after: number, through = Number.MAX_SAFE_INTEGER): Generator<AuditRecord> {
    let sequence = after, count = 0;
    while (sequence < through) {
      const page = this.store.page(scopeId, sequence, Math.min(this.policy.pageSize, through - sequence));
      if (page.length === 0) break;
      for (const input of page) {
        if (++count > this.policy.maxRecords) throw new AuditError('AUDIT_LIMIT');
        const row = verifyAuditRecord(input, this.authority);
        if (row.event.scopeId !== scopeId || row.sequence !== sequence + AUDIT_SEQUENCE_STEP || row.sequence > through) throw new AuditError('AUDIT_INTEGRITY');
        sequence = row.sequence; yield row;
      }
    }
  }
  /** Called inside the append transaction, only for a newly inserted ordinary event. */
  afterRecord(record: AuditRecord): void {
    const scopeId = record.event.scopeId;
    const head = this.store.latestCheckpoint(scopeId);
    const previous = head === null ? null : verifyAuditCheckpointRecord(head, this.authority);
    if (previous && (previous.event.scopeId !== scopeId || previous.event.subject.kind !== 'audit-checkpoint'
      || previous.event.subject.lastSequence !== previous.sequence - AUDIT_SEQUENCE_STEP)) throw new AuditError('AUDIT_INTEGRITY');
    const start = (previous?.sequence ?? 0) + AUDIT_SEQUENCE_STEP;
    if (record.sequence - start + AUDIT_SEQUENCE_STEP < this.policy.everyRecords) return;
    let digest = initialDigest(), records = 0;
    for (const row of this.range(scopeId, start - AUDIT_SEQUENCE_STEP, record.sequence)) {
      if (row.event.subject.kind === 'audit-checkpoint') throw new AuditError('AUDIT_INTEGRITY');
      digest = addDigest(digest, row); records++;
    }
    if (records !== record.sequence - start + AUDIT_SEQUENCE_STEP) throw new AuditError('AUDIT_INTEGRITY');
    const subject: AuditCheckpointSubject = { kind: 'audit-checkpoint', schemaVersion: AUDIT_CHECKPOINT_SCHEMA_VERSION, firstSequence: start, lastSequence: record.sequence,
      records, cadence: this.policy.everyRecords, intervalDigest: digest, previousCheckpointDigest: previous === null ? null : auditCheckpointDigest(previous) };
    const event = { ...record.event, eventId: sha256(encodeCommandProjection('audit-checkpoint-event:1', { scopeId, subject })), subject };
    const checkpoint = this.store.append(event, sequence => sealAuditRecord(event, sequence, this.authority));
    if (checkpoint.sequence !== record.sequence + AUDIT_SEQUENCE_STEP) throw new AuditError('AUDIT_INTEGRITY');
  }
  verify(input: AuditCheckpointVerifyCommand): AuditCheckpointVerification {
    const parsed = auditCheckpointVerifyCommandSchema.safeParse(input);
    if (!parsed.success) throw new AuditError('AUDIT_INVALID');
    const command = parsed.data;
    return this.store.snapshot(() => {
      let latest: AuditCheckpointRecord | null = null, digest = initialDigest(), pending = 0, records = 0, checkpoints = 0, missing = false, anchored = !command.anchor;
      for (const row of this.range(command.scopeId, 0)) {
        records++;
        const subject = row.event.subject;
        if (subject.kind !== 'audit-checkpoint') { digest = addDigest(digest, row); pending++; continue; }
        if (subject.firstSequence !== (latest?.sequence ?? 0) + AUDIT_SEQUENCE_STEP || subject.lastSequence !== row.sequence - AUDIT_SEQUENCE_STEP || subject.records !== pending
          || subject.intervalDigest !== digest || subject.previousCheckpointDigest !== (latest === null ? null : auditCheckpointDigest(latest))) {
          throw new AuditError('AUDIT_INTEGRITY');
        }
        if (pending < subject.cadence) throw new AuditError('AUDIT_INTEGRITY');
        if (pending > subject.cadence) missing = true;
        if (command.anchor?.sequence === row.sequence) {
          if (command.anchor.digest !== auditCheckpointDigest(row)) throw new AuditError('AUDIT_INTEGRITY');
          anchored = true;
        }
        latest = verifyAuditCheckpointRecord(row, this.authority); checkpoints++; pending = 0; digest = initialDigest();
      }
      if (!anchored || pending >= this.policy.everyRecords) missing = true;
      return Object.freeze({ schemaVersion: AUDIT_CHECKPOINT_SCHEMA_VERSION, scopeId: command.scopeId, status: missing ? 'missing-checkpoint' : 'verified', records, checkpoints,
        pendingRecords: pending, latestCheckpoint: latest, anchor: latest ? { sequence: latest.sequence, digest: auditCheckpointDigest(latest) } : null });
    });
  }
}
