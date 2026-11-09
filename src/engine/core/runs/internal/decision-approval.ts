import { randomUUID } from 'node:crypto';
import { approvalDecisionClass, approvalRequestSchema, encodeCommandProjection, evaluatePolicy, explicitDecisionGrant, isAiPrincipal, readRunHold,
  ApprovalError, policySchema, type RunSnapshot, type VerifiedPrincipal } from '#domain/index.js';
import { sha256, t, type IntegrityAuthority, type Locale } from '#platform/index.js';
import { RunLifecycleError, type RunDecisionAuthorization, type RunDecisionEvidence, type RunLifecycleCommand, type RunLifecycleWrite } from './lifecycle.js';
import { PolicyAuthorizationError, policyVerdictRefusal, type PolicySource } from '#engine/core/policy/index.js';
import { admitDecided, expireDue, sealApproval, verifyApproval, minimumApprovalAssurance, type ApprovalStore } from '#engine/core/approval/index.js';
/** Decision routing reuses the existing task subject, command-bound digest, sealed store and approval decision owner. */
export class RunDecisionApprovalBroker implements RunDecisionAuthorization {
  constructor(private readonly store: ApprovalStore, private readonly integrity: IntegrityAuthority, private readonly policy: PolicySource,
    private readonly interactive: (principal: VerifiedPrincipal) => Promise<boolean>, private readonly now: () => number,
    private readonly ttlMs: number, private readonly admitWithinMs: number, private readonly locale: Locale) {
    for (const value of [ttlMs, admitWithinMs]) if (!Number.isSafeInteger(value) || value < 1) throw new ApprovalError('APPROVAL_INVALID');
  }
  async authorize(command: RunLifecycleCommand, principal: VerifiedPrincipal, run: RunSnapshot, replay?: RunLifecycleWrite): Promise<RunDecisionEvidence> {
    const ai = isAiPrincipal(principal), witness = !ai && await this.interactive(principal);
    const policy = policySchema.parse(await this.policy.load());
    const taskStep = 'taskId' in command, kind = taskStep ? 'task-decision' : 'run-decision', id = taskStep ? command.taskId : command.runId;
    const sameReplayActor = replay?.actor.issuer === principal.issuer && replay.actor.subject === principal.subject && replay.actor.id === principal.id;
    // S5b (Auditor owner decision 6): hold is the ordinary control; every resume is a decision. A replay of a resume recorded as an
    // operator control before this release returns that receipt unchanged (the store writes nothing new for it).
    const ordinary = command.action === 'hold' || sameReplayActor && replay?.action === 'resume' && replay.decision?.step === 'operator-control';
    const personOnly = command.action === 'quota-answer' || command.action === 'resume' && (readRunHold(run.state)?.source ?? 'operator') !== 'operator';
    const targetId = taskStep ? run.bindings.find(binding => binding.identity.taskId === command.taskId)?.identity.attemptId
      ?? run.progress.find(task => task.taskId === command.taskId)?.inputAnswer?.source.attemptId : command.runId;
    if (!targetId) throw new ApprovalError('APPROVAL_CONFLICT');
    const control = evaluatePolicy(policy, { principal, scopeId: command.scopeId,
      action: taskStep ? 'evaluate' : command.action === 'hold' || command.action === 'close' ? 'cancel' : 'reserve',
      resource: { kind: taskStep ? 'attempt' : 'run', id: targetId } });
    const refusal = policyVerdictRefusal(control.decision, { deny: 'POLICY_DENIED' }); if (refusal) throw new PolicyAuthorizationError(refusal);
    const ruleId = ordinary ? control.ruleId : explicitDecisionGrant(policy, principal, command.scopeId, kind, id, command.action);
    const evidence = (deciderClass: RunDecisionEvidence['deciderClass'], rule?: string, approvalId?: string): RunDecisionEvidence => ({ schemaVersion: 1,
      deciderClass, step: ordinary ? 'operator-control' : 'human-step', policyRevision: policy.revision, ...(rule ? { ruleId: rule } : {}), ...(approvalId ? { approvalId } : {}) });
    // Accept/reject by a script/AI always opens a card, including when that actor has a delegated decision cell.
    if (command.action !== 'accept' && command.action !== 'reject') {
      if (witness) return sameReplayActor && replay?.decision ? replay.decision : evidence('human-tty');
      // A safety hold (Nervous pause, Auditor park) is lifted only by a witnessed person; no policy cell stands in for them.
      if (personOnly) throw new RunLifecycleError(command.action === 'quota-answer' ? 'RUN_QUOTA_PERSON_REQUIRED' : 'RUN_HOLD_PERSON_REQUIRED');
      if (ruleId) return sameReplayActor && replay?.decision ? replay.decision : evidence('ai-policy', ruleId);
      throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
    }
    const requester = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    const digest = sha256(encodeCommandProjection('task-decision-approval:1', { command, requester }));
    let record = this.store.find(command.scopeId, command.runId, command.taskId, digest);
    // An existing routed request cannot be bypassed by returning in a terminal or changing policy.
    if (!record && witness) return sameReplayActor && replay?.decision ? replay.decision : evidence('human-tty');
    const now = this.now();
    if (!record) {
      const action = command.action === 'accept' ? t('approval.taskDecision.accept', {}, this.locale) : t('approval.taskDecision.reject', {}, this.locale);
      const request = approvalRequestSchema.parse({ schemaVersion: 3, approvalId: randomUUID(), scopeId: command.scopeId,
        subject: { kind: 'task', runId: command.runId, taskId: command.taskId }, requester, actionDigest: digest, policyRevision: policy.revision,
        summary: t('approval.taskDecision.summary', { action, runId: command.runId, taskId: command.taskId, revision: command.expectedRevision }, this.locale),
        createdAt: now, expiresAt: now + this.ttlMs, facts: { risk: { source: 'cell', cell: `task-${command.action}` }, reversibility: null, onExpiry: 'nothing-runs',
          requiredAssurance: minimumApprovalAssurance(policy, command.scopeId, 'task', null) } });
      record = verifyApproval(this.store.create(sealApproval({ request, revision: 0, status: 'pending', decision: null }, this.integrity)), this.integrity);
    }
    record = verifyApproval(record, this.integrity);
    if (record.request.actionDigest !== digest) throw new ApprovalError('APPROVAL_CONFLICT');
    const consumed = sameReplayActor && replay?.decision?.approvalId === record.request.approvalId;
    if (!consumed && record.request.policyRevision !== policy.revision) throw new ApprovalError('APPROVAL_STALE');
    record = expireDue(this.store, this.integrity, record, now);
    if (record.status === 'pending') throw new RunLifecycleError('TASK_DECISION_APPROVAL_REQUIRED', record.request.approvalId);
    const decider = record.decision ? approvalDecisionClass(record.decision) : 'unknown', counted = decider === 'human-tty' || decider === 'ai-policy' ? decider : null;
    admitDecided(record, consumed ? null : { now, window: this.admitWithinMs }, counted !== null);
    // The decision's class names who decided the card, even when the requester resubmits it.
    return consumed ? replay!.decision! : evidence(counted!, undefined, record.request.approvalId);
  }
}
