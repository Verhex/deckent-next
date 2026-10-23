import { evaluatePolicy, policyResources, type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError, type PolicySource } from '#engine/core/policy/index.js';
import type { AgentCatalogAction } from './contract.js';
/** `agent-catalog`/<action> on the scope itself; require-approval is not offered (the person's terminal card is the default approval, AJAN-ORG S6). */
export class AgentCatalogPolicyAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: AgentCatalogAction, scopeId: string, principal: VerifiedPrincipal) {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, scopeId, action, resource: { kind: policyResources.agentCatalog.kind, id: scopeId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
    if (!decision.ruleId) throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
    return { revision: decision.revision, ruleId: decision.ruleId };
  }
}
