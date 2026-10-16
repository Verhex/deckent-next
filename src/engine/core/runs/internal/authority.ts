import { commandEnvelopeSchema, encodeCommandProjection, evaluatePolicy, policySchema, AuditError,
  type AuthorityAdmission, type AuditRecord, type Policy, type PolicyDecision, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry, sha256, type TrustedClock, type Locale, type KnownSecretSnapshot } from '#platform/index.js';
import { AuditApplication, AuthorityDecisionRecords } from '#engine/core/audit/index.js';
import { RunCreateApprovalBroker, type RunCreateApprovalInput } from '#engine/core/approval/index.js';
import { PolicyAuthorizationError, type PolicySource } from '#engine/core/policy/index.js';
import { runCreateSchema, RunStoreError, type RunCreate } from './store.js';
import type { RunWorkspaceCustody } from '#engine/core/workspaces/index.js';
import type { BoundRunAdmission } from './admission.js';
import { renderRunCreateApprovalSummary } from './approval-summary.js';
export type RunAdmissionEvaluation = { readonly policy: Policy; readonly verdict: PolicyDecision };
const hash = (tag: string, input: unknown) => sha256(encodeCommandProjection(tag, input));
/** Run's first consumer of general sealed authority decisions; only evaluatePolicy owns policy semantics. */
export class RunCreationAuthority {
  constructor(private readonly source: PolicySource, private readonly records: AuthorityDecisionRecords,
    private readonly approvals: RunCreateApprovalBroker, private readonly clock: TrustedClock,
    private readonly presentation: { readonly locale?: Locale; readonly known?: KnownSecretSnapshot } = {}) {}
  async evaluate(command: BoundRunAdmission, principal: VerifiedPrincipal): Promise<RunAdmissionEvaluation> {
    let policy: Policy, verdict: PolicyDecision;
    try { policy = policySchema.parse(await this.source.load()); verdict = evaluatePolicy(policy, { principal, action: 'create',
      scopeId: command.scopeId, resource: { kind: 'run', id: command.runId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (verdict.decision === 'deny') {
      this.seal(command, principal, { policy, verdict }, null);
      throw new PolicyAuthorizationError('POLICY_DENIED');
    }
    return { policy, verdict };
  }
  evaluatePermissions(command: BoundRunAdmission, principal: VerifiedPrincipal, evaluation: RunAdmissionEvaluation): RunAdmissionEvaluation {
    let verdict = evaluation.verdict;
    for (const permission of command.proposal?.requiredPermissions ?? []) {
      const checked = evaluatePolicy(evaluation.policy, { principal, scopeId: command.scopeId, action: permission.action, resource: { kind: permission.kind, id: permission.resourceId } });
      if (verdict.decision !== 'deny' && (checked.decision === 'deny' || (checked.decision === 'require-approval' && verdict.decision === 'allow'))) verdict = checked;
    }
    if (verdict.decision === 'deny') { this.seal(command, principal, { ...evaluation, verdict }, null); throw new PolicyAuthorizationError('POLICY_DENIED'); }
    return { ...evaluation, verdict };
  }
  async prepare(command: BoundRunAdmission, principal: VerifiedPrincipal, evaluation: RunAdmissionEvaluation, create: RunCreate, workspace?: RunWorkspaceCustody) {
    // Resolution may have awaited catalogs or workspace custody; never apply a stale sampled policy.
    const current = policySchema.parse(await this.source.load());
    if (hash('policy:1', current) !== hash('policy:1', evaluation.policy)) {
      this.recordUnapplied(command, principal, evaluation);
      throw ErrorRegistry.createError('APPROVAL_STALE');
    }
    // A proposal may only lower the registry gate when every exact class declares low risk and standing admission.
    // It never lowers policy require-approval or deny.
    if (command.proposal && !command.proposal.admission) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
    if (command.proposal && !command.proposal.admission!.standingAdmission && evaluation.verdict.decision === 'allow') {
      evaluation = { ...evaluation, verdict: { decision: 'require-approval', revision: evaluation.verdict.revision, reason: 'APPROVAL_REQUIRED' } };
    }
    const record = this.seal(command, principal, evaluation, this.basis(create, workspace));
    const reference = { eventId: record.event.eventId, sequence: record.sequence };
    const approvalInput = { ...this.approvalInput(record, evaluation.policy), summary: renderRunCreateApprovalSummary(command, create,
      evaluation.verdict, this.presentation.locale, this.presentation.known) };
    if (evaluation.verdict.decision === 'allow') this.approvals.assertUnrequested(command.scopeId, command.commandId);
    const authority: AuthorityAdmission = evaluation.verdict.decision === 'allow' ? { decision: reference }
      : { decision: reference, approval: this.approve(approvalInput) };
    return { authority, assert: () => {
      this.records.verify(record);
      if (!authority.approval) this.approvals.assertUnrequested(command.scopeId, command.commandId);
      if (authority.approval && encodeCommandProjection('approval-reference:1', this.approve(approvalInput)) !== encodeCommandProjection('approval-reference:1', authority.approval)) throw new AuditError('AUDIT_INTEGRITY');
    } };
  }
  /** A evaluated Run policy remains evidence even when another admission prerequisite refuses the effect. */
  recordUnapplied(command: BoundRunAdmission, principal: VerifiedPrincipal, evaluation: RunAdmissionEvaluation): void {
    this.seal(command, principal, evaluation, null);
  }
  verifyReplay(command: BoundRunAdmission, principal: VerifiedPrincipal, create: RunCreate, workspace?: RunWorkspaceCustody): void {
    if (!create.authority) return; // Historical pre-v52 receipts stay byte-exact; no invented decision.
    const record = this.records.load(command.scopeId, create.authority.decision.eventId);
    if (!record || record.sequence !== create.authority.decision.sequence || record.event.subject.kind !== 'authority-decision') throw new AuditError('AUDIT_INTEGRITY');
    const subject = record.event.subject;
    if (subject.envelope.commandId !== command.commandId || subject.envelope.scopeId !== command.scopeId
      || encodeCommandProjection('actor:1', subject.envelope.principalRef) !== encodeCommandProjection('actor:1', { id: principal.id, issuer: principal.issuer, subject: principal.subject })
      || subject.action !== 'create' || subject.resource.kind !== 'run' || subject.resource.id !== command.runId
      || subject.inputDigest !== hash('run-admission:1', command) || subject.basisDigest !== hash('run-admission-basis:1', this.basis(create, workspace))) throw new RunStoreError('RUN_COMMAND_CONFLICT');
    if (subject.verdict.decision === 'deny' || (subject.verdict.decision === 'require-approval') !== (create.authority.approval !== undefined)) throw new AuditError('AUDIT_INTEGRITY');
    if (create.authority.approval) this.approvals.verifyConsumed(this.approvalInput(record, null), create.authority.approval);
  }
  private basis(create: RunCreate, workspace?: RunWorkspaceCustody) {
    return { create: runCreateSchema.omit({ now: true, authority: true }).strip().parse(create), workspace: workspace ?? null };
  }
  private seal(command: BoundRunAdmission, principal: VerifiedPrincipal, evaluation: RunAdmissionEvaluation, basis: unknown) {
    const envelope = commandEnvelopeSchema.parse({ schemaVersion: 1, commandId: command.commandId, scopeId: command.scopeId,
      principalRef: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, idempotencyKeyHash: sha256(command.commandId) });
    return this.records.record({ kind: 'authority-decision', schemaVersion: 1, envelope, action: 'create', resource: { kind: 'run', id: command.runId },
      inputDigest: hash('run-admission:1', command), basisDigest: basis === null ? null : hash('run-admission-basis:1', basis),
      policyDigest: hash('policy:1', evaluation.policy), verdict: evaluation.verdict }, this.clock.sample().wallMs);
  }
  private approvalInput(record: AuditRecord, policy: unknown): RunCreateApprovalInput {
    const subject = record.event.subject;
    if (subject.kind !== 'authority-decision' || subject.basisDigest === null) throw new AuditError('AUDIT_INTEGRITY');
    return { scopeId: record.event.scopeId, requester: subject.envelope.principalRef, policyRevision: record.event.policyRevision, policy,
      subject: { kind: 'run-create', commandId: subject.envelope.commandId, runId: subject.resource.id, inputDigest: subject.inputDigest,
        admissionDigest: subject.basisDigest, decisionRecordId: record.event.eventId } };
  }
  private approve(input: RunCreateApprovalInput): NonNullable<AuthorityAdmission['approval']> {
    const outcome = this.approvals.admit(input);
    if ('pending' in outcome) throw ErrorRegistry.createError('RUN_APPROVAL_REQUIRED', { params: { ...outcome.pending, decisionRecordId: input.subject.decisionRecordId } });
    return outcome.approved;
  }
}

export function createRunCreationAuthority(source: PolicySource, audit: ConstructorParameters<typeof AuditApplication>[0], approvals: ConstructorParameters<typeof RunCreateApprovalBroker>[0],
  integrity: ConstructorParameters<typeof AuditApplication>[1], clock: TrustedClock, requestTtlMs: number, presentation: { locale?: Locale; known?: KnownSecretSnapshot }) {
  return new RunCreationAuthority(source, new AuthorityDecisionRecords(new AuditApplication(audit, integrity)),
    new RunCreateApprovalBroker(approvals, integrity, clock, { requestTtlMs, admitWithinMs: requestTtlMs }), clock, presentation);
}
