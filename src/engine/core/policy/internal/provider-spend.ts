import { evaluatePolicy, policyResources, type VerifiedPrincipal } from '#domain/index.js';
import type { ProviderSpendAccountAuthorizer } from '#engine/core/provider-spend/index.js';
import { PolicyAuthorizationError, type PolicySource } from './authorize.js';

/** A model-invocation grant never implies access to the shared account of its scope. */
export class ProviderSpendAccountPolicyAuthorization implements ProviderSpendAccountAuthorizer {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: Parameters<ProviderSpendAccountAuthorizer['authorize']>[0],
    target: Parameters<ProviderSpendAccountAuthorizer['authorize']>[1], principal: VerifiedPrincipal) {
    let decision;
    try {
      decision = evaluatePolicy(await this.source.load(), { principal, scopeId: target.scopeId, action,
        resource: { kind: policyResources.providerSpendAccount.kind, id: target.budgetId } });
    } catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
    if (!decision.ruleId) throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
    return Object.freeze({ revision: decision.revision, ruleId: decision.ruleId });
  }
}
