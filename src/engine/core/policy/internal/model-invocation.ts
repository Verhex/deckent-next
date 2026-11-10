import { evaluatePolicy, policyResources, type VerifiedPrincipal } from '#domain/index.js';
import { modelInvocationTargetId, type ModelInvocationAuthorizer } from '#engine/core/model-invocation/index.js';
import { PolicyAuthorizationError, type PolicySource } from './authorize.js';
import { policyVerdictRefusal } from './verdict.js';

/** Invocation has its own effect authority; activation never implies permission to send a request. */
export class ModelInvocationPolicyAuthorization implements ModelInvocationAuthorizer {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: Parameters<ModelInvocationAuthorizer['authorize']>[0],
    target: Parameters<ModelInvocationAuthorizer['authorize']>[1], principal: VerifiedPrincipal) {
    let decision;
    try {
      decision = evaluatePolicy(await this.source.load(), { principal, scopeId: target.scopeId, action,
        resource: { kind: policyResources.modelInvocation.kind, id: modelInvocationTargetId(target.reference) } });
    } catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    const refusal = policyVerdictRefusal(decision.decision, { deny: 'POLICY_DENIED' });
    if (refusal) throw new PolicyAuthorizationError(refusal);
    if (!decision.ruleId) throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
    return Object.freeze({ revision: decision.revision, ruleId: decision.ruleId });
  }
}
