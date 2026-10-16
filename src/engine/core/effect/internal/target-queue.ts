import { targetQueueKey } from './queue-key.js';
import { assertCandidateEvidence, targetQueueRequestSchema, targetQueueRecordSchema, TargetQueueError, queueTerminal, queueNextState,
  encodeCommandProjection, type TargetQueueRequest, type TargetQueueRecord, type TargetBinding, type VerifiedPrincipal } from '#domain/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';

export interface TargetQueueBounds { readonly capacity: number; readonly perTarget: number; readonly activeTargets: number;
  readonly batchSize: number; readonly batchWindowMs: number; readonly leaseMs: number; readonly verificationTimeoutMs: number; readonly revalidations: number }
/** All callback work is synchronous under the shared ledger transaction. No target/process/TTY I/O while holding the writer. */
export interface TargetQueueStore {
  enqueue(request: TargetQueueRequest, bounds: TargetQueueBounds, audit: (store: AuditStore, record: TargetQueueRecord) => void): TargetQueueRecord;
  load(scopeId: string, commandId: string): TargetQueueRecord | null;
  epoch(key: string): number;
  head(key: string): TargetQueueRecord | null;
  list(scopeId: string, after: string | null, limit: number): readonly TargetQueueRecord[];
  change(previous: TargetQueueRecord, next: TargetQueueRecord, bounds: TargetQueueBounds, audit: (store: AuditStore, record: TargetQueueRecord) => void): TargetQueueRecord;
}
export interface TargetQueueAuthority {
  authorize(request: TargetQueueRequest, principal: VerifiedPrincipal, action: 'submit' | 'inspect' | 'cancel'): Promise<void>;
  /** Checks exact accepted Attempt/output, physical source binding and target protection before durable admission. */
  validate(request: TargetQueueRequest): Promise<void>;
}
export type TargetQueueAudit = (store: AuditStore, record: TargetQueueRecord) => void;
/** Service-owned admission, immutable scoped replay and CAS transitions. This scheduler never implements external effects. */
export class TargetQueueApplication {
  constructor(private readonly store: TargetQueueStore, private readonly authority: TargetQueueAuthority,
    private readonly bounds: TargetQueueBounds, private readonly audit: TargetQueueAudit) { assertTargetQueueBounds(bounds); }
  async submit(input: unknown, principal: VerifiedPrincipal): Promise<TargetQueueRecord> {
    const request = targetQueueRequestSchema.parse(input);
    await this.authority.authorize(request, principal, 'submit');
    if (request.actor.id !== principal.id || request.actor.issuer !== principal.issuer || request.actor.subject !== principal.subject
      || !principal.scopeIds.includes(request.identity.scopeId)) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
    const previous = this.store.load(request.identity.scopeId, request.commandId);
    if (previous) {
      if (encodeCommandProjection('queue-request:1', previous.request) !== encodeCommandProjection('queue-request:1', request)) throw new TargetQueueError('QUEUE_CONFLICT');
      return previous;
    }
    await this.authority.validate(request);
    return this.store.enqueue(request, this.bounds, this.audit);
  }
  async inspect(scopeId: string, commandId: string, principal: VerifiedPrincipal): Promise<TargetQueueRecord | null> {
    if (!principal.scopeIds.includes(scopeId)) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
    const record = this.store.load(scopeId, commandId);
    if (record) await this.authority.authorize(record.request, principal, 'inspect');
    return record;
  }
  /** Ownership is a CAS of the eligible head. TTL never transfers ownership; recovery must fence physical effects first. */
  claim(record: TargetQueueRecord, ownerInstance: string, now: number): TargetQueueRecord {
    if (record.state !== 'queued' || record.ownerInstance !== null || record.request.deadline <= now) throw new TargetQueueError('QUEUE_CONFLICT');
    const head = this.store.head(record.key);
    if (!head || head.request.commandId !== record.request.commandId || head.request.identity.scopeId !== record.request.identity.scopeId)
      throw new TargetQueueError('QUEUE_TARGET_BUSY');
    return this.transition(record, { state: 'revalidating', ownerInstance, epoch: this.store.epoch(record.key) + 1, leaseDeadline: now + this.bounds.leaseMs });
  }
  transition(previous: TargetQueueRecord, fields: Partial<Pick<TargetQueueRecord, 'state' | 'ownerInstance' | 'epoch' | 'leaseDeadline' | 'candidate' | 'verification' | 'batchDigest' | 'effectCommandIds' | 'evidenceRefs' | 'outcome'>>): TargetQueueRecord {
    queueNextState(previous, fields.state ?? previous.state);
    const next = targetQueueRecordSchema.parse({ ...previous, ...fields, revision: previous.revision + 1 });
    assertQueueChange(previous, next);
    return this.store.change(previous, next, this.bounds, this.audit);
  }
  async cancel(record: TargetQueueRecord, principal: VerifiedPrincipal): Promise<TargetQueueRecord> {
    await this.authority.authorize(record.request, principal, 'cancel');
    if (!principal.scopeIds.includes(record.request.identity.scopeId)) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
    return this.transition(record, { state: 'cancelled' });
  }
}
/** Canonical identity helpers shared with the persistence adapter; no source-specific address syntax. */
export function newQueueRecord(request: TargetQueueRequest, ordinal: number): TargetQueueRecord {
  return targetQueueRecordSchema.parse({ schemaVersion: 1, request, key: targetQueueKey(request.target), ordinal, revision: 0, state: 'queued',
    ownerInstance: null, epoch: 0, leaseDeadline: null, candidate: null, verification: null, batchDigest: null, effectCommandIds: [], evidenceRefs: [], outcome: null });
}
export function assertQueueChange(previous: TargetQueueRecord, next: TargetQueueRecord) {
  if (encodeCommandProjection('queue-request:1', previous.request) !== encodeCommandProjection('queue-request:1', next.request)
    || previous.key !== next.key || previous.ordinal !== next.ordinal || next.revision !== previous.revision + 1 || queueTerminal(previous.state))
    throw new TargetQueueError('QUEUE_CONFLICT');
  queueNextState(previous, next.state);
  if (previous.state === 'queued' && next.state === 'revalidating') {
    if (!next.ownerInstance || next.epoch <= previous.epoch || next.leaseDeadline === null) throw new TargetQueueError('QUEUE_CONFLICT');
  } else if (next.ownerInstance !== previous.ownerInstance || next.epoch !== previous.epoch || next.leaseDeadline !== previous.leaseDeadline) {
    throw new TargetQueueError('QUEUE_CONFLICT');
  }
  if (next.state === 'publishing') {
    if (!next.candidate || !next.verification || !next.batchDigest) throw new TargetQueueError('QUEUE_CONFIRMATION_REQUIRED');
    assertCandidateEvidence(next.candidate, next.verification);
  }
  if (next.state === 'settled' && (next.outcome === 'adopted' || next.outcome === 're-prepared+adopted')) {
    if (!next.evidenceRefs.length || !next.candidate || !next.verification) throw new TargetQueueError('QUEUE_RECOVERY_REQUIRED');
    assertCandidateEvidence(next.candidate, next.verification);
  }
}
export function sameQueueTarget(a: TargetBinding, b: TargetBinding): boolean { return targetQueueKey(a) === targetQueueKey(b); }

/** No implicit worker counts or mutable policy literals: the caller supplies the complete effective configuration. */
export function assertTargetQueueBounds(bounds: TargetQueueBounds): void {
  for (const key of ['capacity', 'perTarget', 'activeTargets', 'batchSize', 'batchWindowMs', 'leaseMs', 'verificationTimeoutMs', 'revalidations'] as const) {
    const value = bounds[key];
    if (!Number.isSafeInteger(value) || value < (key === 'revalidations' ? 0 : 1)) throw new TargetQueueError('QUEUE_CAPACITY');
  }
  if (bounds.batchSize > bounds.perTarget || bounds.perTarget > bounds.capacity || bounds.activeTargets > bounds.capacity)
    throw new TargetQueueError('QUEUE_CAPACITY');
}

export function decodeTargetQueueRow(row: Record<string, unknown>): TargetQueueRecord {
    let record: TargetQueueRecord;
    try { record = targetQueueRecordSchema.parse(JSON.parse(String(row.record))); } catch { throw new TargetQueueError('QUEUE_CORRUPT'); }
    if (record.key !== row.target_key || targetQueueKey(record.request.target) !== record.key || record.ordinal !== row.ordinal
      || record.revision !== row.revision || record.state !== row.state || record.request.identity.scopeId !== row.scope_id || record.request.commandId !== row.command_id)
      throw new TargetQueueError('QUEUE_CORRUPT');
    return record;
  }
