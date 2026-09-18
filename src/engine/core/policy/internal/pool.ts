import { evaluatePolicy, policyResources, type VerifiedPrincipal } from '#domain/index.js';
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
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
  }
}
