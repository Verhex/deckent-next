import { evaluatePolicy, policyResources, type VerifiedPrincipal } from '#domain/index.js';
import { modelActivationTargetId, type ModelActivationAuthorizer } from '#engine/core/model-activation/index.js';
import { PolicyAuthorizationError, type PolicySource } from './authorize.js';

/** Stable reference target, separate from the mutable native semantic binding held by activation state. */
export class ModelActivationPolicyAuthorization implements ModelActivationAuthorizer {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: Parameters<ModelActivationAuthorizer['authorize']>[0],
    target: Parameters<ModelActivationAuthorizer['authorize']>[1], principal: VerifiedPrincipal) {
    let decision;
    try {
      decision = evaluatePolicy(await this.source.load(), { principal, scopeId: target.scopeId, action,
        resource: { kind: policyResources.modelActivation.kind, id: modelActivationTargetId(target.reference) } });
    } catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
    if (!decision.ruleId) throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
    return Object.freeze({ revision: decision.revision, ruleId: decision.ruleId });
  }
}
