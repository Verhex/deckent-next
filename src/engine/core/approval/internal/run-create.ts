import { randomUUID } from 'node:crypto';
import { approvalRequestSchema, approvalSubject, encodeCommandProjection, samePrincipalRef, ApprovalError,
  type ApprovalActor, type ApprovalSubject, type AuthorityAdmission } from '#domain/index.js';
import { sha256, type IntegrityAuthority, type TrustedClock } from '#platform/index.js';
import type { ApprovalStore } from './store.js';
import { admitDecided, approvalActorRef, approvalRequestDigest, expireApproval, expireDue, sealApproval, verifyApproval, witnessedPersonDecision } from './integrity.js';
import { minimumApprovalAssurance } from './assurance.js';
type Subject = Extract<ApprovalSubject, { kind: 'run-create' }>;
export interface RunCreateApprovalInput { readonly scopeId: string; readonly subject: Subject; readonly requester: ApprovalActor;
  readonly policyRevision: string; readonly policy: unknown; readonly summary?: string; readonly personDecision?: boolean }
export const RUN_CREATE_SUBJECT_PROTOCOL_VERSION = 27;
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
    const fresh = () => sealApproval({ request: approvalRequestSchema.parse({ schemaVersion: 3, approvalId: randomUUID(), scopeId: input.scopeId,
        subject: input.subject, requester: input.requester, policyRevision: input.policyRevision, actionDigest: digest,
        summary: input.summary ?? `${input.subject.runId} · ${input.subject.inputDigest.slice(0, 12)} · ${input.subject.decisionRecordId}`, createdAt: now,
        expiresAt: now + this.options.requestTtlMs, facts: { risk: input.personDecision ? { source: 'effect-class', effectClass: 'write', authority: true } : null, reversibility: null, onExpiry: 'nothing-runs',
          requiredAssurance: minimumApprovalAssurance(input.policy, input.scopeId, 'run-create', null) } }), revision: 0, status: 'pending', decision: null }, this.integrity);
    if (!record) try { record = this.store.create(fresh()); } catch (error) { const winner = this.store.findRunCreate(input.scopeId, input.subject.commandId); if (!winner) throw error; record = winner; }
    record = verifyApproval(record, this.integrity);
    // L1c: the same plan (command, Run, input, requester) whose basis changed before it was used (the person's mode, the policy revision): the unused card is
    // retired and a fresh card with the current basis and summary asks again. The old decision never admits the changed basis; a denial stands.
    const held = approvalSubject(record.request) as Subject, same = held.kind === 'run-create' && held.commandId === input.subject.commandId && held.runId === input.subject.runId && held.inputDigest === input.subject.inputDigest;
    if (record.request.actionDigest !== digest && same && samePrincipalRef(approvalActorRef(record.request.requester), approvalActorRef(input.requester)) && (record.status === 'pending' || record.decision?.decision === 'allow')) {
      try { record = this.store.supersedeRunCreate(record.status === 'pending' ? expireApproval(this.store, this.integrity, record) : record, fresh()); } /* an old pending card ends expired, never answerable */ catch (error) { const winner = this.store.findRunCreate(input.scopeId, input.subject.commandId); if (!winner || winner.request.actionDigest !== digest) throw error; record = verifyApproval(winner, this.integrity); }
    }
    if (record.request.actionDigest !== digest || record.request.policyRevision !== input.policyRevision
      || encodeCommandProjection('run-create-subject:1', approvalSubject(record.request)) !== encodeCommandProjection('run-create-subject:1', input.subject)
      || !samePrincipalRef(approvalActorRef(record.request.requester), approvalActorRef(input.requester))) throw new ApprovalError('APPROVAL_CONFLICT');
    record = expireDue(this.store, this.integrity, record, now);
    if (record.status === 'pending') return { pending: { approvalId: record.request.approvalId, expiresAt: record.request.expiresAt } };
    const decision = admitDecided(record, { now, window: this.options.admitWithinMs }, !input.personDecision || witnessedPersonDecision(record));
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
    admitDecided(record, null, !input.personDecision || witnessedPersonDecision(record));
  }
}
