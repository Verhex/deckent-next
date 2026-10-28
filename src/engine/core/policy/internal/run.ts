import { evaluatePolicy, policyResources, policySchema, principalGrants, type CorePolicyAction, type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError, type PolicySource } from './authorize.js';
interface RunAuthorizationQuery { readonly scopeId: string; readonly runId: string }
export class RunPolicyAuthorization {
  constructor(private readonly source: PolicySource) {}
  /** An alternate local path cannot circumvent a company restriction on background work. No Run is admitted here. */
  async creationPaused(scopeId: string, principal: VerifiedPrincipal): Promise<boolean> {
    const policy = policySchema.parse(await this.source.load());
    const ids = [scopeId, ...[...principalGrants(policy, principal), ...policy.restrictions]
      .filter(rule => rule.resource.kind === policyResources.run.kind).flatMap(rule => rule.resource.ids === 'all' ? [] : rule.resource.ids)];
    return ids.some(id => {
      const verdict = evaluatePolicy(policy, { principal, scopeId, action: 'create', resource: { kind: policyResources.run.kind, id } });
      return verdict.decision === 'deny';
    });
  }
  async authorize(action: CorePolicyAction<'run'>, query: RunAuthorizationQuery, principal: VerifiedPrincipal): Promise<void> {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, action, scopeId: query.scopeId, resource: { kind: policyResources.run.kind, id: query.runId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    // C12 Q8: outside the operation catalog there is no approval broker yet; require-approval must not silently collapse into denial.
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
  }
}
