import { delegationWithin, evaluatePolicy, policyResources, policySchema, type VerifiedPrincipal } from '#domain/index.js';
import { modelActivationTargetId, modelCatalogTargetId, type ModelActivationAuthorizer, type ModelCatalogAuthorizer } from '#engine/core/model-activation/index.js';
import { PolicyAuthorizationError, type PolicySource } from './authorize.js';

/** Stable reference target, separate from the mutable native semantic binding held by activation state. */
export class ModelActivationPolicyAuthorization implements ModelActivationAuthorizer {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: Parameters<ModelActivationAuthorizer['authorize']>[0],
    target: Parameters<ModelActivationAuthorizer['authorize']>[1], principal: VerifiedPrincipal) {
    let decision;
    try {
      decision = evaluatePolicy(await this.source.load(), { principal, scopeId: target.scopeId, action,
        resource: { kind: policyResources.modelActivation.kind, id: modelActivationTargetId(target.reference) } });
    } catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    // C12 Q8: outside the operation catalog there is no approval broker yet; require-approval must not silently collapse into denial.
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
    if (!decision.ruleId) throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
    return Object.freeze({ revision: decision.revision, ruleId: decision.ruleId });
  }
}
/**
 * Ledger model catalog (WORKER-CURRENCY-1): the same `model-activation` resource and actions; the id is the catalog target digest.
 * `scope` level (activate/deactivate of one scope's rows): the ordinary scoped decision. `installation` level (register: facts every scope
 * reads — Astra 2197 WC-R1, Jev 7fe896d7): the scoped decision (membership) and the existing policy.administer delegation bound over
 * `scopes: 'all'` on the same policy snapshot, so only authority held in every scope — including scopes registered later — passes, and a
 * deny or restriction in any one scope refuses.
 */
export class ModelCatalogPolicyAuthorization implements ModelCatalogAuthorizer {
  constructor(private readonly source: PolicySource) {}
  async authorize(...[action, scopeId, target, principal, level]: Parameters<ModelCatalogAuthorizer['authorize']>) {
    let decision, installation = true;
    try {
      const policy = await this.source.load(), id = modelCatalogTargetId(target);
      decision = evaluatePolicy(policy, { principal, scopeId, action, resource: { kind: policyResources.modelActivation.kind, id } });
      if (level === 'installation') installation = delegationWithin(policySchema.parse(policy), principal, [{ id: 'model-catalog-facts', effect: 'allow',
        actions: [action], scopes: 'all', resource: { kind: policyResources.modelActivation.kind, ids: [id] } }]).ok;
    } catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow' || !installation) throw new PolicyAuthorizationError('POLICY_DENIED');
    if (!decision.ruleId) throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
    return Object.freeze({ revision: decision.revision, ruleId: decision.ruleId });
  }
}
