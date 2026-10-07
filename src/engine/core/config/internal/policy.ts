import { delegationWithin, evaluatePolicy, policyResources, policySchema, type VerifiedPrincipal } from '#domain/index.js';
import { ConfigApplicationError, type ConfigAuthorization, type ConfigWriteInput } from './contract.js';
/**
 * Existing policy engine decides the exact layer/key resource; a global change requires authority in every scope. The write is bound to the
 * config-change permission policy gives this principal for this layer, key and scope — never a role flag (T3 L2, Jev f0214347). `deny`
 * throws; `require-approval` is returned (T3 L2), and on the global layer it must hold in every scope as an allow would.
 */
export function evaluateConfigWrite(document: unknown, principal: VerifiedPrincipal, input: ConfigWriteInput): ConfigAuthorization {
  if (principal.issuer !== input.principal.issuer || principal.subject !== input.principal.subject || !input.principal.scopeIds.includes(input.scopeId)) throw new ConfigApplicationError('POLICY_DENIED');
  const resource = { kind: policyResources.config.kind, id: `${input.layer ?? 'project'}:${input.keyPath}` }, action = policyResources.config.actions[0];
  const decision = evaluatePolicy(document, { principal, scopeId: input.scopeId, action, resource });
  if (decision.decision === 'deny' || input.layer === 'global' && !delegationWithin(policySchema.parse(document), principal,
    [{ id: 'config-global', effect: decision.decision, actions: [action], scopes: 'all', resource: { kind: resource.kind, ids: [resource.id] } }]).ok) throw new ConfigApplicationError('POLICY_DENIED');
  return Object.freeze({ decision: decision.decision, revision: decision.revision, ruleId: decision.ruleId ?? null });
}
/** The allow-only form (every caller without an approval port): `require-approval` stays `POLICY_APPROVAL_UNSUPPORTED`, checked first as before. */
export function authorizeConfigWrite(document: unknown, principal: VerifiedPrincipal, input: ConfigWriteInput): string {
  if (principal.issuer !== input.principal.issuer || principal.subject !== input.principal.subject || !input.principal.scopeIds.includes(input.scopeId)) throw new ConfigApplicationError('POLICY_DENIED');
  const resource = { kind: policyResources.config.kind, id: `${input.layer ?? 'project'}:${input.keyPath}` }, action = policyResources.config.actions[0];
  if (evaluatePolicy(document, { principal, scopeId: input.scopeId, action, resource }).decision === 'require-approval') throw new ConfigApplicationError('POLICY_APPROVAL_UNSUPPORTED');
  return evaluateConfigWrite(document, principal, input).revision;
}
