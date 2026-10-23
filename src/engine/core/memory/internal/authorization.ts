import { evaluatePolicy, policyResources, type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError, type PolicySource } from '#engine/core/policy/index.js';
import type { MemoryAction } from './contract.js';
/** `memory`/<action> on the scope itself; require-approval is not offered for memory transitions in v1. */
export class MemoryPolicyAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: MemoryAction, scopeId: string, principal: VerifiedPrincipal) {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, scopeId, action, resource: { kind: policyResources.memory.kind, id: scopeId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
    if (!decision.ruleId) throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
    return { revision: decision.revision, ruleId: decision.ruleId };
  }
}
