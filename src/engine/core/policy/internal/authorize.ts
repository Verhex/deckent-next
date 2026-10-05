import { delegationWithin, evaluatePolicy, policyResources, policySchema, type AttemptIdentity, type VerifiedPrincipal } from '#domain/index.js';
import type { DispatchAuthorization, DispatchIdentityAuthorization, DispatchInventoryAuthorization } from '#engine/core/dispatch/index.js';
import type { SandboxRequest } from '#engine/core/supervisor/index.js';
/** Trusted composition provides authority documents, never model output or caller-authored wire fields. */
export interface PolicySource { load(): Promise<unknown> }
/** Internal typed cause of a `SCOPE_UNKNOWN` refusal (H34 S3): the scope belongs to another company, or to none. Never on the wire:
 * surfaces carry the code only, so a caller cannot tell a scope held by another company from an unknown one (no disclosure). */
export type PolicyRefusalReason = 'COMPANY' | 'UNREGISTERED';
export class PolicyAuthorizationError extends Error {
  constructor(readonly code: 'POLICY_UNAVAILABLE' | 'POLICY_DENIED' | 'SCOPE_UNKNOWN' | 'POLICY_APPROVAL_UNSUPPORTED',
    readonly reason: PolicyRefusalReason | null = null) { super(code); this.name = 'PolicyAuthorizationError'; }
}
export class DispatchPolicyAuthorization implements DispatchAuthorization, DispatchIdentityAuthorization {
  constructor(private readonly source: PolicySource) {}
  /** A collection exposes every resource id, including future ones. A grant on one id cannot admit it;
   * any intersecting deny/require-approval refuses the collection before its rows are read. */
  async authorizeScopeReadOutput(scopeId: string, principal: VerifiedPrincipal): Promise<void> {
    if (!principal.scopeIds.includes(scopeId)) throw new PolicyAuthorizationError('SCOPE_UNKNOWN');
    const policy = policySchema.parse(await this.source.load());
    const verdict = delegationWithin(policy, principal, [{ id: 'collection-read', effect: 'allow', scopes: [scopeId],
      actions: ['read-output'], resource: { kind: policyResources.attempt.kind, ids: 'all' } }]);
    if (!verdict.ok) throw new PolicyAuthorizationError(verdict.reason === 'require-approval' ? 'POLICY_APPROVAL_UNSUPPORTED' : 'POLICY_DENIED');
  }
  async authorize(action: Parameters<DispatchAuthorization['authorize']>[0], request: SandboxRequest, principal: VerifiedPrincipal): Promise<void> {
    return this.authorizeIdentity(action, request.identity, principal);
  }
  async authorizeIdentity(action: Parameters<DispatchAuthorization['authorize']>[0], identity: AttemptIdentity, principal: VerifiedPrincipal): Promise<void> {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, action, scopeId: identity.scopeId,
      resource: { kind: policyResources.attempt.kind, id: identity.attemptId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    // C12 Q8: outside the operation catalog there is no approval broker yet; require-approval must not silently collapse into denial.
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
  }
}

export class DispatchInventoryPolicyAuthorization implements DispatchInventoryAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(scopeId: string, principal: VerifiedPrincipal): Promise<void> {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, action: policyResources.scope.actions[0], scopeId, resource: { kind: policyResources.scope.kind, id: scopeId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
  }
}
