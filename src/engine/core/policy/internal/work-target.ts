import { evaluatePolicy, policyResources, type VerifiedPrincipal } from '#domain/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { PolicyAuthorizationError, type PolicySource } from './authorize.js';
import { PoolPolicyAuthorization, type PoolAuthorization } from './pool.js';

export type WorkTargetAction = typeof policyResources.workTarget.actions[number];
/** Current authority over one configured work target (WORK-TARGETS, owner 2026-09-30 K2 = A); the resource id is the target id. */
export class WorkTargetPolicyAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: WorkTargetAction, targetId: string, scopeId: string, principal: VerifiedPrincipal): Promise<void> {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, action, scopeId, resource: { kind: policyResources.workTarget.kind, id: targetId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    // As for pools: outside the operation catalog there is no approval broker, so require-approval never collapses into denial.
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
  }
}
/** Execution resources a Run consumes at admission and reservation: its pool and, when a work target is configured, that target
 * (`work-target:use`). Without a target id this is exactly the pool check. Slice 1 takes the id from the current config at both checks;
 * the Run does not record it yet. */
export function executionResourceAuthorization(source: PolicySource, workTargetId: string | null): PoolAuthorization {
  const pool = new PoolPolicyAuthorization(source);
  if (workTargetId === null) return pool;
  const target = new WorkTargetPolicyAuthorization(source);
  return { async authorize(poolId, scopeId, principal) {
    await pool.authorize(poolId, scopeId, principal);
    await target.authorize('use', workTargetId, scopeId, principal);
  } };
}
/** Attempt authorization for adoption: adopting or rolling back also moves the configured work target's branch, so both need
 * `work-target:adopt` on that target in addition to their attempt action, at every check (the first one and the re-check before the
 * effect). Without a target id the attempt authorization is returned unchanged. */
export function workTargetAdoptionAuthorization(attempts: DispatchIdentityAuthorization, source: PolicySource, workTargetId: string | null): DispatchIdentityAuthorization {
  if (workTargetId === null) return attempts;
  const target = new WorkTargetPolicyAuthorization(source);
  return { async authorizeIdentity(action, identity, principal) {
    await attempts.authorizeIdentity(action, identity, principal);
    if (action === 'adopt-integration' || action === 'rollback-integration') await target.authorize('adopt', workTargetId, identity.scopeId, principal);
  } };
}
