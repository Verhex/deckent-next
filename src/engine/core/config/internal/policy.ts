import { delegationWithin, evaluatePolicy, policyResources, policySchema, type VerifiedPrincipal } from '#domain/index.js';
import { ConfigApplicationError, type ConfigWriteInput } from './contract.js';
/** Existing policy engine decides the exact layer/key resource; a global change requires authority in every scope. */
export function authorizeConfigWrite(document: unknown, principal: VerifiedPrincipal, input: ConfigWriteInput): string {
  if (principal.issuer !== input.principal.issuer || principal.subject !== input.principal.subject || !input.principal.scopeIds.includes(input.scopeId)) throw new ConfigApplicationError('POLICY_DENIED');
  const resource = { kind: policyResources.config.kind, id: `${input.layer ?? 'project'}:${input.keyPath}` }, action = policyResources.config.actions[0];
  const decision = evaluatePolicy(document, { principal, scopeId: input.scopeId, action, resource });
  if (decision.decision === 'require-approval') throw new ConfigApplicationError('POLICY_APPROVAL_UNSUPPORTED');
  if (decision.decision !== 'allow' || input.layer === 'global' && !delegationWithin(policySchema.parse(document), principal,
    [{ id: 'config-global', effect: 'allow', actions: [action], scopes: 'all', resource: { kind: resource.kind, ids: [resource.id] } }]).ok) throw new ConfigApplicationError('POLICY_DENIED');
  return decision.revision;
}
