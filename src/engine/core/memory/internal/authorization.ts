import { evaluatePolicy, policyResources, type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError, type PolicySource } from '#engine/core/policy/index.js';
import type { MemoryAction, MemoryReadFilter } from './contract.js';
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
  /** S4B-1 §7.4: one policy load, then a pure view (`allow` only; require-approval and every refusal withhold). An unreadable policy withholds nothing
   * silently: it is POLICY_UNAVAILABLE, like the read's own authorization. */
  async readFilter(principal: VerifiedPrincipal, scopeId: string): Promise<MemoryReadFilter> {
    let document: unknown;
    try { document = await this.source.load(); } catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    return (resource, action) => { try { return evaluatePolicy(document, { principal, scopeId, action, resource }).decision === 'allow'; } catch { return false; } };
  }
}
