import { delegationWithin, evaluatePolicy, policyResources, policySchema, type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError, type PolicySource } from './authorize.js';

/** Current authority to consume an assigned execution pool. */
export interface PoolAuthorization {
  authorize(poolId: string, scopeId: string, principal: VerifiedPrincipal): Promise<void>;
}

export class PoolPolicyAuthorization implements PoolAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(poolId: string, scopeId: string, principal: VerifiedPrincipal): Promise<void> {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, action: policyResources.pool.actions[0], scopeId,
      resource: { kind: policyResources.pool.kind, id: poolId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    // C12 Q8: outside the operation catalog there is no approval broker yet; require-approval must not silently collapse into denial.
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
  }
}

export type PoolControlAction = 'hold' | 'resume' | 'inspect';
/** The decision on one `pool` control cell, kept for the audit record: effect, the deciding rule (null when none) and the policy revision. */
export interface PoolControlDecision { readonly effect: 'allow' | 'deny' | 'require-approval'; readonly ruleId: string | null; readonly revision: string }
export interface PoolControlAuthorization {
  decide(action: PoolControlAction, poolId: string, scopeId: string, principal: VerifiedPrincipal): Promise<PoolControlDecision>;
}
/**
 * K5 typed pool hold. A pool has no scope (every scope's Runs share it), so `hold`/`resume` stop or restart reservations installation-wide
 * and take installation-level authority — the WC-R1 pattern of the ledger model catalog: the scoped decision (membership) **and** the
 * delegation bound over `scopes: 'all'` on the same policy snapshot (a deny or restriction in any one scope refuses; scopes registered later
 * are covered). `inspect` reads the status with the scoped decision only. Returns the decision; the caller records it and refuses.
 */
export class PoolControlPolicyAuthorization implements PoolControlAuthorization {
  constructor(private readonly source: PolicySource) {}
  async decide(action: PoolControlAction, poolId: string, scopeId: string, principal: VerifiedPrincipal): Promise<PoolControlDecision> {
    try {
      const policy = await this.source.load(), resource = { kind: policyResources.pool.kind, id: poolId };
      const scoped = evaluatePolicy(policy, { principal, scopeId, action, resource });
      const installation = action === 'inspect' || scoped.decision !== 'allow' || delegationWithin(policySchema.parse(policy), principal,
        [{ id: 'pool-control', effect: 'allow', actions: [action], scopes: 'all', resource: { kind: resource.kind, ids: [poolId] } }]).ok;
      // A scoped allow without the installation bound is a denial no single rule decided (ruleId null).
      return Object.freeze({ effect: installation ? scoped.decision : 'deny', ruleId: installation ? scoped.ruleId ?? null : null, revision: scoped.revision });
    } catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
  }
}
/** Throws the typed refusal of a recorded decision; an allowed decision passes. */
export function assertPoolControlAllowed(decision: PoolControlDecision): void {
  if (decision.effect === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
  if (decision.effect !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
  if (!decision.ruleId) throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
}
