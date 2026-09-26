import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { includes, policySchema } from './evaluate.js';

/** Company identity (H34): one registry key per customer company; the same shape the installation config accepts. */
export const companyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

type Actor = { readonly issuer: string; readonly subject: string };
function allowGrants(input: unknown, actor: Actor) {
  const policy = policySchema.parse(input); const issuer = identitySchema.parse(actor.issuer); const subject = identitySchema.parse(actor.subject);
  return policy.grants.filter(rule => rule.effect === 'allow' && (rule.principals === 'all'
    || rule.principals.some(principal => principal.issuer === issuer && principal.subject === subject)));
}
const unique = (candidates: readonly string[]) => [...new Set(candidates.map(candidate => identitySchema.parse(candidate)))];

/** Scopes the trusted policy names explicitly in an allow grant. A named scope is declared by the installation authority;
 * `'all'` declares nothing. */
export function policyDeclaredScopes(input: unknown): readonly string[] {
  const policy = policySchema.parse(input);
  return Object.freeze([...new Set(policy.grants.flatMap(rule => rule.effect === 'allow' && rule.scopes !== 'all' ? rule.scopes : []))]);
}

/** Grant precondition only: candidates some trusted allow grant of this actor covers, before any registry lookup.
 * It is not membership — an `'all'` grant covers every candidate here, registered or not. */
export function policyScopeGrants(input: unknown, actor: Actor, candidates: readonly string[]): readonly string[] {
  const grants = allowGrants(input, actor);
  return Object.freeze(unique(candidates).filter(scope => grants.some(rule => includes(rule.scopes, scope))));
}

/** Fail-closed membership (H34): a grant reaches a candidate only when the scope is registered to the request's company.
 * `'all'` means every registered scope, never a scope nobody registered. This is not action authorization:
 * evaluatePolicy must still enforce resource/action matching, explicit denies and restrictions.
 */
export function policyScopeMembership(input: unknown, actor: Actor, candidates: readonly string[], registered: ReadonlySet<string>): readonly string[] {
  const grants = allowGrants(input, actor);
  return Object.freeze(unique(candidates).filter(scope => grants.some(rule =>
    (rule.scopes === 'all' ? registered.has(scope) : rule.scopes.includes(scope) && registered.has(scope)))));
}
