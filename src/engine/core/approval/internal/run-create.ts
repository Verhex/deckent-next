import { randomUUID } from 'node:crypto';
import { approvalRequestSchema, approvalSubject, encodeCommandProjection, ApprovalError,
  type ApprovalActor, type ApprovalSubject, type AuthorityAdmission } from '#domain/index.js';
import { MAX_WALL_SKEW_MS, sha256, type IntegrityAuthority, type TrustedClock } from '#platform/index.js';
import type { ApprovalStore } from './store.js';
import { approvalRequestDigest, expireApproval, sealApproval, verifyApproval } from './integrity.js';
import { minimumApprovalAssurance } from './assurance.js';
type Subject = Extract<ApprovalSubject, { kind: 'run-create' }>;
export interface RunCreateApprovalInput { readonly scopeId: string; readonly subject: Subject; readonly requester: ApprovalActor;
  readonly policyRevision: string; readonly policy: unknown; readonly summary?: string }
export const RUN_CREATE_SUBJECT_PROTOCOL_VERSION = 27;
/** Same broker custody/expiry/session decision contract as operations. One command cannot replace its approved input or actor. */
export class RunCreateApprovalBroker {
  constructor(private readonly store: ApprovalStore, private readonly integrity: IntegrityAuthority, private readonly clock: TrustedClock,
    private readonly options: { readonly requestTtlMs: number; readonly admitWithinMs: number }) {
    for (const value of [options.requestTtlMs, options.admitWithinMs]) if (!Number.isSafeInteger(value) || value < 1) throw new ApprovalError('APPROVAL_INVALID');
  }
  /** Once a command asked for approval, a changed policy cannot silently replace that decision with a new allow. */
  assertUnrequested(scopeId: string, commandId: string): void {
    if (this.store.findRunCreate(scopeId, commandId)) throw new ApprovalError('APPROVAL_CONFLICT');
  }
  admit(input: RunCreateApprovalInput): { pending: { approvalId: string; expiresAt: number } } | { approved: NonNullable<AuthorityAdmission['approval']> } {
    const digest = sha256(encodeCommandProjection('run-create-approval:1', { scopeId: input.scopeId, subject: input.subject, requester: input.requester }));
    const now = this.clock.sample().wallMs;
    let record = this.store.findRunCreate(input.scopeId, input.subject.commandId);
    if (!record) {
      const request = approvalRequestSchema.parse({ schemaVersion: 3, approvalId: randomUUID(), scopeId: input.scopeId,
        subject: input.subject, requester: input.requester, policyRevision: input.policyRevision, actionDigest: digest,
        summary: input.summary ?? `${input.subject.runId} · ${input.subject.inputDigest.slice(0, 12)} · ${input.subject.decisionRecordId}`, createdAt: now,
        expiresAt: now + this.options.requestTtlMs, facts: { risk: null, reversibility: null, onExpiry: 'nothing-runs',
          requiredAssurance: minimumApprovalAssurance(input.policy, input.scopeId, 'run-create', null) } });
      try { record = this.store.create(sealApproval({ request, revision: 0, status: 'pending', decision: null }, this.integrity)); }
      catch (error) { const winner = this.store.findRunCreate(input.scopeId, input.subject.commandId); if (!winner) throw error; record = winner; }
    }
    record = verifyApproval(record, this.integrity);
    if (record.request.actionDigest !== digest || record.request.policyRevision !== input.policyRevision
      || encodeCommandProjection('run-create-subject:1', approvalSubject(record.request)) !== encodeCommandProjection('run-create-subject:1', input.subject)
      || encodeCommandProjection('requester:1', record.request.requester) !== encodeCommandProjection('requester:1', input.requester)) throw new ApprovalError('APPROVAL_CONFLICT');
    if (record.status === 'pending' && now >= record.request.expiresAt) record = expireApproval(this.store, this.integrity, record);
    if (record.status === 'pending') return { pending: { approvalId: record.request.approvalId, expiresAt: record.request.expiresAt } };
    if (record.status === 'expired') throw new ApprovalError('APPROVAL_EXPIRED');
    const decision = record.decision!;
    if (decision.decision !== 'allow') throw new ApprovalError('APPROVAL_DENIED');
    if (decision.requestDigest !== approvalRequestDigest(record.request)) throw new ApprovalError('APPROVAL_INTEGRITY');
    if (decision.decidedAt > now + MAX_WALL_SKEW_MS) throw new ApprovalError('APPROVAL_CONFLICT');
    if (now > decision.decidedAt + this.options.admitWithinMs) throw new ApprovalError('APPROVAL_EXPIRED');
    return { approved: { approvalId: record.request.approvalId, actionDigest: digest, requestDigest: decision.requestDigest, commandId: decision.commandId } };
  }
  /** A committed Run is historical replay, not a new use of an expired admission window. */
  verifyConsumed(input: RunCreateApprovalInput, reference: NonNullable<AuthorityAdmission['approval']>): void {
    const loaded = this.store.load(input.scopeId, reference.approvalId);
    if (!loaded) throw new ApprovalError('APPROVAL_MISSING');
    const record = verifyApproval(loaded, this.integrity);
    const digest = sha256(encodeCommandProjection('run-create-approval:1', { scopeId: input.scopeId, subject: input.subject, requester: input.requester }));
    if (record.status !== 'decided' || record.decision?.decision !== 'allow' || record.request.actionDigest !== digest || reference.actionDigest !== digest
      || record.decision.commandId !== reference.commandId || record.decision.requestDigest !== reference.requestDigest
      || approvalRequestDigest(record.request) !== reference.requestDigest) throw new ApprovalError('APPROVAL_CONFLICT');
  }
}
