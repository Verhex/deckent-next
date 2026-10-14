import { evaluatePolicy } from './evaluate.js';
import { includes, policySchema, principalGrants } from './schema.js';
import type { VerifiedPrincipal } from '#domain/core/principal/index.js';
/** An explicit named actor/action cell, never a wildcard action or the old evaluate/reserve permission. Denies/asks win. */
export function explicitDecisionGrant(input: unknown, principal: VerifiedPrincipal, scopeId: string, kind: string, id: string, action: string): string | null {
  if (evaluatePolicy(input, { principal, scopeId, action, resource: { kind, id } }).decision !== 'allow') return null;
  return principalGrants(policySchema.parse(input), principal).find(rule => rule.effect === 'allow' && rule.principals !== 'all'
    && rule.principals.some(ref => ref.issuer === principal.issuer && ref.subject === principal.subject)
    && rule.actions !== 'all' && rule.actions.includes(action) && includes(rule.scopes, scopeId)
    && rule.resource.kind === kind && includes(rule.resource.ids, id))?.id ?? null;
}
