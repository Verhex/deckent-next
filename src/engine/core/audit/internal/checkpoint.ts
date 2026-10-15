import { encodeCommandProjection, auditCheckpointSchema, auditWitnessSchema, AuditError,
  type AuditCheckpoint, type AuditWitness, type AuditVerification } from '#domain/index.js';
import { sha256, type IntegrityAuthority } from '#platform/index.js';
import { AUDIT_PAGE_MAX, AuditApplication } from './application.js';
import type { AuditCheckpointStore } from './checkpoint-store.js';
export interface AuditCheckpointContext { readonly installationId: string; readonly policyDigest: string; readonly producersDigest: string }
export interface AuditVerificationLimits { readonly pageSize: number; readonly maxRecords: number }
/** Who writes a checkpoint's wipe marker: the service's own verified principal and the policy revision in force. */
/** Exactly what the person confirmed on the re-baseline card; the write re-checks all of it inside its own transaction. */
export interface AuditRebaselineExpectation { readonly status: AuditVerification['status']; readonly head: AuditVerification['head']; readonly policyDigest: string; readonly producersDigest: string }
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
/** Whether a scope has any retained audit evidence (an event or a checkpoint row); nothing recorded needs no key to report no-checkpoint-yet. */
export const auditScopeRecorded = (store: AuditCheckpointStore, scopeId: string): boolean => store.page(scopeId, 0, 1).length > 0 || store.checkpointPage(scopeId, 0, 1).length > 0;
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
    let sequence = 0, digest = sha256(encodeCommandProjection('audit-head:1', { scopeId })), index = 0;
    const governed: { sequence: number; before: string | null; after: string }[] = [];
    const markers = new Map<number, number>();
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
        if (subject.kind === 'audit-checkpoint') {
          // An explicit re-baseline supersedes every earlier marker from its sequence on; any other repeated marker is a forged history.
          if (subject.rebaseline) { for (const key of [...markers.keys()]) if (key >= subject.checkpointSequence) markers.delete(key); }
          else if (markers.has(subject.checkpointSequence)) throw new AuditError('AUDIT_INTEGRITY');
          markers.set(subject.checkpointSequence, sequence);
        }
        // A governed policy write (policy.administer, /mode, installer) seals the digests of the policy it changed and of the policy it produced.
        if ((subject.kind === 'authority-change' || subject.kind === 'permission-mode-change') && subject.policyDigest) governed.push({ sequence, before: subject.policyDigestBefore ?? null, after: subject.policyDigest });
      }
    }
    const head = Object.freeze({ sequence, digest });
    if (index < anchors.length || (witness && (!latest || latest.sequence < witness.checkpoint.sequence))) return this.result(scopeId, 'truncated', 'head-missing', head, exported);
    // Every stored checkpoint has its sealed marker as its exact head; a marker without its checkpoint is a wipe, never a fresh baseline.
    for (const cp of checkpoints) if (markers.get(cp.sequence) !== cp.head.sequence) throw new AuditError('AUDIT_INTEGRITY');
    if (markers.size > checkpoints.length) return this.result(scopeId, 'possible-wipe', 'checkpoints-missing', head, exported);
    if (!latest && !witness) return this.result(scopeId, 'unknown', 'no-checkpoint-yet', head);
    const compared = [...(latest ? [latest] : []), ...(witness ? [witness.checkpoint] : [])];
    // The current policy is accepted only along an unbroken chain from a checkpoint: every governed write after it changed exactly the policy
    // the chain holds and produced the next one, ending at the current policy. An out-of-band edit before or between them breaks the chain, so a
    // later governed write never launders it; the drift stays visible until a person re-baselines.
    const accepted = (cp: AuditCheckpoint) => {
      let chain = cp.policyDigest;
      for (const change of governed) if (change.sequence > cp.head.sequence) { if (change.before !== chain) return false; chain = change.after; }
      return chain === context.policyDigest;
    };
    if (!compared.every(accepted)) return this.result(scopeId, 'policy-changed', 'policy', head, exported);
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
      const previous = verified.checkpoint?.checkpoint;
      if (previous && previous.head.sequence === verified.head!.sequence) return verified;
      return this.append(scopeId, context, atMs, writer, verified);
    }); } catch (error) { return this.result(scopeId, error instanceof AuditError && error.code === 'AUDIT_INTEGRITY' ? 'chain-broken' : 'unknown',
      error instanceof AuditError && error.code === 'AUDIT_INTEGRITY' ? 'integrity' : 'unavailable'); }
  }
  /**
   * The explicit operator re-baseline (the caller has authorized it and taken a witnessed human y/N): only a policy or producer drift or a
   * possible wipe can be re-based; a broken chain, truncation, limit or unknown state cannot. One transaction appends a sealed marker that
   * carries the reason and supersedes earlier markers from its sequence on, then the checkpoint over the current state.
   */
  rebaseline(scopeId: string, context: AuditCheckpointContext, atMs: number, writer: AuditCheckpointWriter, reason: string, expected: AuditRebaselineExpectation,
    authorize: () => void): AuditVerification {
    let denied: unknown = null;
    try { return this.store.snapshot(true, () => {
      const verified = this.scan(scopeId, context);
      if (!['policy-changed', 'producers-changed', 'possible-wipe'].includes(verified.status)) throw new AuditError('AUDIT_REBASELINE_REFUSED');
      // The confirmation binds the shown state: any change of status, audit head, policy or producers since then refuses (the caller asks again).
      if (verified.status !== expected.status || verified.head?.sequence !== expected.head?.sequence || verified.head?.digest !== expected.head?.digest
        || context.policyDigest !== expected.policyDigest || context.producersDigest !== expected.producersDigest) throw new AuditError('AUDIT_REBASELINE_STALE');
      // The caller's authority over exactly that policy is decided again inside this write (REVIEW2561 R2): a revoked or denied grant writes nothing,
      // and its own typed refusal reaches the caller (the store would otherwise name any foreign error unavailable).
      try { authorize(); } catch (error) { denied = error; throw new AuditError('AUDIT_INVALID'); }
      return this.append(scopeId, context, atMs, writer, verified, reason);
    }); } catch (error) { throw denied ?? error; }
  }
  /** Marker ids carry the audit head they follow, so a sequence re-used after a re-baseline never collides with a superseded marker. */
  private append(scopeId: string, context: AuditCheckpointContext, atMs: number, writer: AuditCheckpointWriter, verified: AuditVerification, reason?: string): AuditVerification {
      const previous = verified.checkpoint?.checkpoint, head = verified.head!;
      if (previous && atMs < previous.atMs) throw new AuditError('AUDIT_INVALID');
      const sequence = (previous?.sequence ?? 0) + 1, previousDigest = previous ? auditCheckpointDigest(previous) : null;
      this.audit.record({ schemaVersion: 1, eventId: `audit-${reason ? 'rebaseline' : 'checkpoint'}-${sequence}-${head.sequence}`, scopeId, principal: writer.principal,
        policyRevision: writer.policyRevision, atMs, subject: { kind: 'audit-checkpoint', checkpointSequence: sequence, previousDigest, ...(reason ? { rebaseline: { reason } } : {}) } });
      const [marker] = this.audit.list(scopeId, head.sequence, 1);
      if (!marker || marker.sequence !== head.sequence + 1 || marker.event.subject.kind !== 'audit-checkpoint') throw new AuditError('AUDIT_CONFLICT');
      const value = { schemaVersion: 1 as const, ...context, scopeId, sequence, atMs, previousDigest, keyId: this.integrity.keyId,
        head: { sequence: marker.sequence, digest: sha256(encodeCommandProjection('audit-link:1', { previousDigest: head.digest, record: marker })) } };
      const checkpoint = auditCheckpointSchema.parse({ ...value, mac: this.integrity.sign(projection(value)) });
      this.store.appendCheckpoint(checkpoint);
      return this.result(scopeId, 'match', 'verified', value.head, exportAuditCheckpoint(checkpoint));
  }
}
