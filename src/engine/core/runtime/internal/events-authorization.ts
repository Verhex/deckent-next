import { evaluatePolicy, type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError } from '#engine/core/policy/index.js';
/** The explicit collection gate narrows model inspection; every exact record still needs its existing authorizer. */
export function authorizeRuntimeEventsInventory(policy: unknown, scopeId: string, principal: VerifiedPrincipal): void {
  const decision = evaluatePolicy(policy, { principal, scopeId, action: 'inspect', resource: { kind: 'model-activation', id: scopeId } });
  if (decision.decision !== 'allow') throw new PolicyAuthorizationError(decision.decision === 'require-approval' ? 'POLICY_APPROVAL_UNSUPPORTED' : 'POLICY_DENIED');
}
