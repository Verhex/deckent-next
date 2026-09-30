import { evaluatePolicy, policyResources, type AttemptIdentity, type CorePolicyAction, type VerifiedPrincipal } from '#domain/index.js';
import type { DispatchAuthorization, DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
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
/** Attempt authorization when a work target is configured: the attempt action AND the target action it consumes, at every check the
 * attempt authorization already has (the first check and each freshness re-check, e.g. the launch gate of DispatchApplication and the
 * adoption re-check before the effect). `execute` consumes the target (`work-target:use`, Sol WT-R1: attempt:execute never substitutes
 * for it); adopting or rolling back moves the target's branch (`work-target:adopt`). The attempt gate runs first and is never bypassed.
 * The caller passes the id of the target the same operation consumes (one config snapshot). Without a target id: unchanged. */
export function workTargetAttemptAuthorization<A extends DispatchAuthorization & DispatchIdentityAuthorization>(attempts: A, source: PolicySource,
  workTargetId: string | null): DispatchAuthorization & DispatchIdentityAuthorization {
  if (workTargetId === null) return attempts;
  const target = new WorkTargetPolicyAuthorization(source);
  const consumed = (action: CorePolicyAction<'attempt'>): WorkTargetAction | null => action === 'execute' ? 'use'
    : action === 'adopt-integration' || action === 'rollback-integration' ? 'adopt' : null;
  const authorizeIdentity = async (action: CorePolicyAction<'attempt'>, identity: AttemptIdentity, principal: VerifiedPrincipal) => {
    await attempts.authorizeIdentity(action, identity, principal);
    const targetAction = consumed(action);
    if (targetAction) await target.authorize(targetAction, workTargetId, identity.scopeId, principal);
  };
  return { authorizeIdentity, authorize: (action, request, principal) => authorizeIdentity(action, request.identity, principal) };
}
