import { encodeCommandProjection, evaluatePolicy, policySchema, ApprovalError, type ApprovalActor, type VerifiedPrincipal, type RunSnapshot } from '#domain/index.js';
import type { IntegrityAuthority } from '#platform/index.js';
import type { ApprovalStore } from './store.js';
import { approvalActionDigest, approvalRequestDigest, expireApproval, verifyApproval } from './integrity.js';
import { requestTaskApproval } from './application.js';

/** Additional task admission restriction. Existing attempt execution authority remains mandatory.
 * NO_GRANT means this optional task-level restriction is absent, never an execution grant.
 */
export class TaskApprovalAdmission {
  private readonly policy: ReturnType<typeof policySchema.parse>;
  constructor(policy: unknown, private readonly principal: VerifiedPrincipal, private readonly store: ApprovalStore,
    private readonly integrity: IntegrityAuthority, private readonly ttlMs: number) {
    this.policy = policySchema.parse(policy);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ApprovalError('APPROVAL_INVALID');
  }
  private decision(run: RunSnapshot, taskId: string) {
    return evaluatePolicy(this.policy, { principal: this.principal, scopeId: run.identity.scopeId,
      action: 'execute', resource: { kind: 'task', id: taskId } });
  }
  private actor(): ApprovalActor { const { id, issuer, subject } = this.principal; return { id, issuer, subject }; }
  async prepare(run: RunSnapshot, principal: VerifiedPrincipal, now: number) {
    if (JSON.stringify(principal) !== JSON.stringify(this.principal)) throw new ApprovalError('APPROVAL_DENIED');
    for (const task of run.progress.filter(task => task.phase === 'pending')) {
      if (this.decision(run, task.taskId).decision !== 'require-approval') continue;
      const request = requestTaskApproval(this.store, this.integrity, { scopeId: run.identity.scopeId,
        runId: run.identity.runId, taskId: task.taskId, requester: this.actor(),
        actionDigest: approvalActionDigest(run, task.taskId, this.actor(), this.policy), policyRevision: this.policy.revision,
        summary: task.taskId, createdAt: now, expiresAt: now + this.ttlMs });
      if (request.status === 'pending' && now >= request.request.expiresAt) expireApproval(this.store, this.integrity, request);
    }
    return this.excluded(run, this.actor(), now);
  }
  /** Synchronous check also called under the shared ledger's write transaction, before prefix selection. */
  excluded(run: RunSnapshot, actor: ApprovalActor, now: number): readonly string[] {
    if (JSON.stringify(actor) !== JSON.stringify(this.actor())) throw new ApprovalError('APPROVAL_DENIED');
    return run.progress.filter(task => task.phase === 'pending').filter(task => {
      const verdict = this.decision(run, task.taskId);
      if (verdict.reason === 'NO_GRANT') return false;
      if (verdict.decision === 'allow') return false;
      if (verdict.decision !== 'require-approval') return true;
      const digest = approvalActionDigest(run, task.taskId, actor, this.policy);
      const stored = this.store.find(run.identity.scopeId, run.identity.runId, task.taskId, digest);
      if (!stored) return true;
      const record = verifyApproval(stored, this.integrity);
      return record.status !== 'decided' || record.decision?.decision !== 'allow' || record.decision.decidedAt > now
        || record.decision.requestDigest !== approvalRequestDigest(record.request);
    }).map(task => task.taskId);
  }
}

/** A fresh command must be retried if trusted policy changed during asynchronous admission. */
export function assertApprovalPolicyCurrent(expected: unknown, current: unknown) {
  const policy = policySchema.parse(current);
  if (encodeCommandProjection('policy:1', policySchema.parse(expected)) !== encodeCommandProjection('policy:1', policy)) throw new ApprovalError('APPROVAL_STALE');
  return policy;
}
