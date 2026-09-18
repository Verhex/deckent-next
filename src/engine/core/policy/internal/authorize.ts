import { evaluatePolicy, policyResources, type AttemptIdentity, type VerifiedPrincipal } from '#domain/index.js';
import type { DispatchAuthorization, DispatchIdentityAuthorization, DispatchInventoryAuthorization } from '#engine/core/dispatch/index.js';
import type { SandboxRequest } from '#engine/core/supervisor/index.js';
/** Trusted composition provides authority documents, never model output or caller-authored wire fields. */
export interface PolicySource { load(): Promise<unknown> }
export class PolicyAuthorizationError extends Error {
  constructor(readonly code: 'POLICY_UNAVAILABLE' | 'POLICY_DENIED') { super(code); this.name = 'PolicyAuthorizationError'; }
}
export class DispatchPolicyAuthorization implements DispatchAuthorization, DispatchIdentityAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: Parameters<DispatchAuthorization['authorize']>[0], request: SandboxRequest, principal: VerifiedPrincipal): Promise<void> {
    return this.authorizeIdentity(action, request.identity, principal);
  }
  async authorizeIdentity(action: Parameters<DispatchAuthorization['authorize']>[0], identity: AttemptIdentity, principal: VerifiedPrincipal): Promise<void> {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, action, scopeId: identity.scopeId,
      resource: { kind: policyResources.attempt.kind, id: identity.attemptId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
  }
}

export class DispatchInventoryPolicyAuthorization implements DispatchInventoryAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(scopeId: string, principal: VerifiedPrincipal): Promise<void> {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, action: policyResources.scope.actions[0], scopeId, resource: { kind: policyResources.scope.kind, id: scopeId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
  }
}
