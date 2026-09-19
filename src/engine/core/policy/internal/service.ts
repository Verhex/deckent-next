import { evaluatePolicy, policyResources, type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError, type PolicySource } from './authorize.js';

export interface ServicePolicyTarget { readonly scopeId: string; readonly serviceId: string }
export interface ServicePolicyGrant { readonly revision: string; readonly ruleId: string }

/** Service grants are independent of Run/project grants. Replay must call this gate again. */
export class ServicePolicyAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(target: ServicePolicyTarget, principal: VerifiedPrincipal): Promise<ServicePolicyGrant> {
    let decision;
    try {
      decision = evaluatePolicy(await this.source.load(), { principal, scopeId: target.scopeId,
        action: policyResources.service.actions[0], resource: { kind: policyResources.service.kind, id: target.serviceId } });
    } catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
    if (!decision.ruleId) throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
    return Object.freeze({ revision: decision.revision, ruleId: decision.ruleId });
  }
}
