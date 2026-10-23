import { evaluatePolicy, isAiPrincipal, policyResources, policySchema, principalGrants, type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError, type PolicySource } from '#engine/core/policy/index.js';
import type { AgentCatalogAction, SignerAction } from './contract.js';
/** `agent-catalog`/<action> (S8-5: or `skill-signer`/<action>) on the scope itself — S8-4: a standing or suggestion action on `<scopeId>/<workClass>`;
 * require-approval is not offered (the person's terminal card is the default approval, AJAN-ORG S6). An AI principal's WorkClass action needs a rule
 * that names exact ids (S8-DESIGN §9, N46): a grant over every id never stands in for one. */
export class AgentCatalogPolicyAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: AgentCatalogAction | SignerAction, scopeId: string, principal: VerifiedPrincipal, resourceId?: string,
    kind: 'agent-catalog' | 'skill-signer' = policyResources.agentCatalog.kind) {
    let decision, document;
    try { document = await this.source.load(); decision = evaluatePolicy(document, { principal, scopeId, action, resource: { kind, id: resourceId ?? scopeId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
    if (!decision.ruleId) throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
    if (resourceId !== undefined && resourceId !== scopeId && isAiPrincipal(principal)
      && principalGrants(policySchema.parse(document), principal).find(rule => rule.id === decision.ruleId)?.resource.ids === 'all') throw new PolicyAuthorizationError('POLICY_DENIED');
    return { revision: decision.revision, ruleId: decision.ruleId };
  }
}
