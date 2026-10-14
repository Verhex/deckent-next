import { encodeCommandProjection, auditCheckpointSchema, auditWitnessSchema, AuditError,
  type AuditCheckpoint, type AuditWitness, type AuditVerification } from '#domain/index.js';
import { sha256, type IntegrityAuthority } from '#platform/index.js';
import { AUDIT_PAGE_MAX, AuditApplication } from './application.js';
import type { AuditCheckpointStore } from './checkpoint-store.js';
export interface AuditCheckpointContext { readonly installationId: string; readonly policyDigest: string; readonly producersDigest: string }
export interface AuditVerificationLimits { readonly pageSize: number; readonly maxRecords: number }
/** Who writes a checkpoint's wipe marker: the service's own verified principal and the policy revision in force. */
export interface AuditCheckpointWriter { readonly principal: { readonly issuer: string; readonly subject: string }; readonly policyRevision: string }
export const auditCheckpointDigest = (checkpoint: AuditCheckpoint): string => sha256(encodeCommandProjection('audit-checkpoint-digest:1', checkpoint));
export const exportAuditCheckpoint = (checkpoint: AuditCheckpoint): AuditWitness => auditWitnessSchema.parse({ schemaVersion: 1,
  kind: 'deckent-audit-checkpoint', checkpoint, digest: auditCheckpointDigest(checkpoint) });
export const auditPolicyDigest = (policy: unknown): string => sha256(encodeCommandProjection('audit-policy:1', policy));
export const auditProducersDigest = (inventory: unknown): string => sha256(encodeCommandProjection('audit-producers:1', inventory));
function unsigned(cp: AuditCheckpoint): Omit<AuditCheckpoint, 'mac'> {
  return { schemaVersion: cp.schemaVersion, installationId: cp.installationId, scopeId: cp.scopeId, sequence: cp.sequence, atMs: cp.atMs,
    head: cp.head, policyDigest: cp.policyDigest, producersDigest: cp.producersDigest, previousDigest: cp.previousDigest, keyId: cp.keyId };
}
const projection = (checkpoint: Omit<AuditCheckpoint, 'mac'>) => encodeCommandProjection('audit-checkpoint:1', checkpoint);
/** No cache/projection is integrity authority. Every read verifies sealed events and historical checkpoint heads. */
export class AuditCheckpointApplication {
  private readonly audit: AuditApplication;
  constructor(private readonly store: AuditCheckpointStore, private readonly integrity: IntegrityAuthority, private readonly limits: AuditVerificationLimits) {
    if (!Number.isSafeInteger(limits.pageSize) || limits.pageSize < 1 || limits.pageSize > AUDIT_PAGE_MAX || !Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1) throw new AuditError('AUDIT_INVALID');
    this.audit = new AuditApplication(store, integrity);
  }
  verify(scopeId: string, context: AuditCheckpointContext, witness?: AuditWitness): AuditVerification {
    try { return this.store.snapshot(false, () => this.scan(scopeId, context, witness)); }
    catch (error) { return this.result(scopeId, error instanceof AuditError && error.code === 'AUDIT_INTEGRITY' ? 'chain-broken' : 'unknown',
      error instanceof AuditError && error.code === 'AUDIT_INTEGRITY' ? 'integrity' : 'unavailable'); }
  }
  private result(scopeId: string, status: AuditVerification['status'], reason: AuditVerification['reason'], head: AuditVerification['head'] = null, checkpoint: AuditWitness | null = null): AuditVerification {
    return Object.freeze({ schemaVersion: 1, scopeId, status, reason, head, checkpoint });
  }
  private scan(scopeId: string, context: AuditCheckpointContext, witness?: AuditWitness): AuditVerification {
    const checkpoints: AuditCheckpoint[] = []; let cursor = 0;
    for (;;) {
      const page = this.store.checkpointPage(scopeId, cursor, this.limits.pageSize);
      if (!page.length) break;
      for (const input of page) {
        if (checkpoints.length >= this.limits.maxRecords) return this.result(scopeId, 'unknown', 'limit');
        const cp = auditCheckpointSchema.parse(input), previous = checkpoints.at(-1);
        if (cp.keyId !== this.integrity.keyId) return this.result(scopeId, 'unknown', 'key-unavailable');
        if (cp.scopeId !== scopeId || cp.installationId !== context.installationId || cp.sequence !== ++cursor
          || cp.previousDigest !== (previous ? auditCheckpointDigest(previous) : null) || (previous && (cp.head.sequence < previous.head.sequence || cp.atMs < previous.atMs))
          || !this.integrity.verify(projection(unsigned(cp)), cp.mac, cp.keyId)) throw new AuditError('AUDIT_INTEGRITY');
        checkpoints.push(cp);
      }
    }
    if (witness) {
      const parsed = auditWitnessSchema.safeParse(witness);
      if (!parsed.success) throw new AuditError('AUDIT_INTEGRITY');
      const cp = parsed.data.checkpoint;
      if (cp.scopeId !== scopeId || cp.installationId !== context.installationId) return this.result(scopeId, 'unknown', 'foreign-witness');
      if (cp.keyId !== this.integrity.keyId) return this.result(scopeId, 'unknown', 'key-unavailable');
      if (parsed.data.digest !== auditCheckpointDigest(cp) || !this.integrity.verify(projection(unsigned(cp)), cp.mac, cp.keyId)) throw new AuditError('AUDIT_INTEGRITY');
      const local = checkpoints.find(item => item.sequence === cp.sequence);
      if (local && auditCheckpointDigest(local) !== parsed.data.digest) throw new AuditError('AUDIT_INTEGRITY');
    }
    const latest = checkpoints.at(-1), exported = latest ? exportAuditCheckpoint(latest) : null;
    const anchors = [...checkpoints, ...(witness ? [witness.checkpoint] : [])].sort((a, b) => a.head.sequence - b.head.sequence);
    let sequence = 0, digest = sha256(encodeCommandProjection('audit-head:1', { scopeId })), index = 0; const markers = new Map<number, number>();
    const checkHeads = () => { while (index < anchors.length && anchors[index]!.head.sequence === sequence) {
      if (anchors[index++]!.head.digest !== digest) throw new AuditError('AUDIT_INTEGRITY');
    } };
    checkHeads();
    for (;;) {
      const page = this.audit.list(scopeId, sequence, this.limits.pageSize);
      if (!page.length) break;
      for (const record of page) {
        if (sequence >= this.limits.maxRecords) return this.result(scopeId, 'unknown', 'limit', { sequence, digest }, exported);
        digest = sha256(encodeCommandProjection('audit-link:1', { previousDigest: digest, record })); sequence = record.sequence; checkHeads();
        const subject = record.event.subject;
        if (subject.kind === 'audit-checkpoint') { if (markers.has(subject.checkpointSequence)) throw new AuditError('AUDIT_INTEGRITY'); markers.set(subject.checkpointSequence, sequence); }
      }
    }
    const head = Object.freeze({ sequence, digest });
    if (index < anchors.length || (witness && (!latest || latest.sequence < witness.checkpoint.sequence))) return this.result(scopeId, 'truncated', 'head-missing', head, exported);
    // Every stored checkpoint has its sealed marker as its exact head; a marker without its checkpoint is a wipe, never a fresh baseline.
    for (const cp of checkpoints) if (markers.get(cp.sequence) !== cp.head.sequence) throw new AuditError('AUDIT_INTEGRITY');
    if (markers.size > checkpoints.length) return this.result(scopeId, 'possible-wipe', 'checkpoints-missing', head, exported);
    if (!latest && !witness) return this.result(scopeId, 'unknown', 'no-checkpoint-yet', head);
    const compared = [...(latest ? [latest] : []), ...(witness ? [witness.checkpoint] : [])];
    if (compared.some(cp => cp.policyDigest !== context.policyDigest)) return this.result(scopeId, 'policy-changed', 'policy', head, exported);
    if (compared.some(cp => cp.producersDigest !== context.producersDigest)) return this.result(scopeId, 'producers-changed', 'producers', head, exported);
    return this.result(scopeId, 'match', 'verified', head, exported);
  }
  /**
   * A drift is never hidden by automatically establishing a new baseline: only a scope with no checkpoint and no marker gets its first one.
   * One write transaction appends the sealed marker event, then the checkpoint whose head is exactly that event. No new event, no new checkpoint.
   */
  checkpoint(scopeId: string, context: AuditCheckpointContext, atMs: number, writer: AuditCheckpointWriter): AuditVerification {
    try { return this.store.snapshot(true, () => {
      const verified = this.scan(scopeId, context);
      if (verified.status !== 'match' && verified.reason !== 'no-checkpoint-yet') return verified;
      const previous = verified.checkpoint?.checkpoint, head = verified.head!;
      if (previous && previous.head.sequence === head.sequence) return verified;
      if (previous && atMs < previous.atMs) throw new AuditError('AUDIT_INVALID');
      const sequence = (previous?.sequence ?? 0) + 1, previousDigest = previous ? auditCheckpointDigest(previous) : null;
      this.audit.record({ schemaVersion: 1, eventId: `audit-checkpoint-${sequence}`, scopeId, principal: writer.principal, policyRevision: writer.policyRevision,
        atMs, subject: { kind: 'audit-checkpoint', checkpointSequence: sequence, previousDigest } });
      const [marker] = this.audit.list(scopeId, head.sequence, 1);
      if (!marker || marker.sequence !== head.sequence + 1 || marker.event.subject.kind !== 'audit-checkpoint') throw new AuditError('AUDIT_CONFLICT');
      const value = { schemaVersion: 1 as const, ...context, scopeId, sequence, atMs, previousDigest, keyId: this.integrity.keyId,
        head: { sequence: marker.sequence, digest: sha256(encodeCommandProjection('audit-link:1', { previousDigest: head.digest, record: marker })) } };
      const checkpoint = auditCheckpointSchema.parse({ ...value, mac: this.integrity.sign(projection(value)) });
      this.store.appendCheckpoint(checkpoint);
      return this.result(scopeId, 'match', 'verified', value.head, exportAuditCheckpoint(checkpoint));
    }); } catch (error) { return this.result(scopeId, error instanceof AuditError && error.code === 'AUDIT_INTEGRITY' ? 'chain-broken' : 'unknown',
      error instanceof AuditError && error.code === 'AUDIT_INTEGRITY' ? 'integrity' : 'unavailable'); }
  }
}
