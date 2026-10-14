import { randomUUID } from 'node:crypto';
import { approvalDecisionClass, approvalRequestSchema, encodeCommandProjection, evaluatePolicy, explicitDecisionGrant, isAiPrincipal,
  ApprovalError, policySchema, type RunSnapshot, type VerifiedPrincipal } from '#domain/index.js';
import { MAX_WALL_SKEW_MS, sha256, t, type IntegrityAuthority, type Locale } from '#platform/index.js';
import { RunLifecycleError, type RunDecisionAuthorization, type RunDecisionEvidence, type RunLifecycleCommand, type RunLifecycleWrite } from './lifecycle.js';
import { PolicyAuthorizationError, type PolicySource } from '#engine/core/policy/index.js';
import { approvalRequestDigest, expireApproval, sealApproval, verifyApproval, minimumApprovalAssurance, type ApprovalStore } from '#engine/core/approval/index.js';
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
    const ordinary = command.action === 'hold' || command.action === 'resume' && (run.state.kind === 'parked' && run.state.reason === 'operator-hold'
      || sameReplayActor && replay?.action === 'resume' && replay.decision?.step === 'operator-control');
    const targetId = taskStep ? run.bindings.find(binding => binding.identity.taskId === command.taskId)?.identity.attemptId
      ?? run.progress.find(task => task.taskId === command.taskId)?.inputAnswer?.source.attemptId : command.runId;
    if (!targetId) throw new ApprovalError('APPROVAL_CONFLICT');
    const control = evaluatePolicy(policy, { principal, scopeId: command.scopeId,
      action: taskStep ? 'evaluate' : command.action === 'hold' || command.action === 'close' ? 'cancel' : 'reserve',
      resource: { kind: taskStep ? 'attempt' : 'run', id: targetId } });
    if (control.decision !== 'allow') throw new PolicyAuthorizationError(control.decision === 'require-approval' ? 'POLICY_APPROVAL_UNSUPPORTED' : 'POLICY_DENIED');
    const ruleId = ordinary ? control.ruleId : explicitDecisionGrant(policy, principal, command.scopeId, kind, id, command.action);
    const evidence = (deciderClass: RunDecisionEvidence['deciderClass'], rule?: string, approvalId?: string): RunDecisionEvidence => ({ schemaVersion: 1,
      deciderClass, step: ordinary ? 'operator-control' : 'human-step', policyRevision: policy.revision, ...(rule ? { ruleId: rule } : {}), ...(approvalId ? { approvalId } : {}) });
    // Accept/reject by a script/AI always opens a card, including when that actor has a delegated decision cell.
    if (command.action !== 'accept' && command.action !== 'reject') {
      if (witness) return sameReplayActor && replay?.decision ? replay.decision : evidence('human-tty');
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
    if (record.status === 'pending' && now >= record.request.expiresAt) record = expireApproval(this.store, this.integrity, record);
    if (record.status === 'pending') throw new RunLifecycleError('TASK_DECISION_APPROVAL_REQUIRED', record.request.approvalId);
    if (record.status === 'expired') throw new ApprovalError('APPROVAL_EXPIRED');
    const decision = record.decision!;
    if (decision.decision !== 'allow') throw new ApprovalError('APPROVAL_DENIED');
    if (decision.requestDigest !== approvalRequestDigest(record.request)) throw new ApprovalError('APPROVAL_INTEGRITY');
    const decider = approvalDecisionClass(decision);
    if (decider !== 'human-tty' && decider !== 'ai-policy') throw new ApprovalError('APPROVAL_DENIED');
    if (!consumed && (decision.decidedAt > now + MAX_WALL_SKEW_MS || now > decision.decidedAt + this.admitWithinMs)) throw new ApprovalError('APPROVAL_EXPIRED');
    // The decision's class names who decided the card, even when the requester resubmits it.
    return consumed ? replay!.decision! : evidence(decider, undefined, record.request.approvalId);
  }
}
