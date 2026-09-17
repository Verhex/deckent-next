import { evaluatePolicy, policyResources, type CorePolicyAction, type VerifiedPrincipal } from '#domain/index.js';
import type { RunAuthorization, RunQuery } from '#engine/core/runs/index.js';
import { PolicyAuthorizationError, type PolicySource } from './authorize.js';
export class RunPolicyAuthorization implements RunAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: CorePolicyAction<'run'>, query: RunQuery, principal: VerifiedPrincipal): Promise<void> {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, action, scopeId: query.scopeId, resource: { kind: policyResources.run.kind, id: query.runId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
  }
}
