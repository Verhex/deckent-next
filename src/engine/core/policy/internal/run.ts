import { evaluatePolicy, policyResources, type CorePolicyAction, type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError, type PolicySource } from './authorize.js';
interface RunAuthorizationQuery { readonly scopeId: string; readonly runId: string }
export class RunPolicyAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: CorePolicyAction<'run'>, query: RunAuthorizationQuery, principal: VerifiedPrincipal): Promise<void> {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, action, scopeId: query.scopeId, resource: { kind: policyResources.run.kind, id: query.runId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    // C12 Q8: outside the operation catalog there is no approval broker yet; require-approval must not silently collapse into denial.
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
  }
}
