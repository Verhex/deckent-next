import { evaluatePolicy, policyResources, type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError, type PolicySource } from '#engine/core/policy/index.js';
import type { HubClientAction } from '#engine/core/hub-client/index.js';
/** Explicit scope grants, deny by default. The person card does not widen policy or authorize a network effect. */
export class HubPolicyAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: HubClientAction, scopeId: string, principal: VerifiedPrincipal) {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, scopeId, action, resource: { kind: policyResources.hub.kind, id: scopeId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
    if (!decision.ruleId) throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
    return { revision: decision.revision, ruleId: decision.ruleId };
  }
}
