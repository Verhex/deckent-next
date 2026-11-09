import { isWorkloadPrincipalRef } from '#domain/core/principal/index.js';
import { policyFileSchema, type PolicyGrant } from './schema.js';

type Person = { readonly issuer: string; readonly subject: string };

/** Whether a rule NAMES this person: a rule for `all` principals names nobody (security, lead 2026-10-07: never proof of an owner). */
export const namesPerson = (grant: PolicyGrant, person: Person) => grant.principals !== 'all' && grant.principals.some(item => item.issuer === person.issuer && item.subject === person.subject);
/** An allow rule that names this person explicitly in exactly this scope (its scopes list it; `all` scopes or `all` principals never count). */
export const anchorsPerson = (grant: PolicyGrant, person: Person, scopeId: string) => grant.effect === 'allow' && namesPerson(grant, person)
  && grant.scopes !== 'all' && grant.scopes.includes(scopeId);
/**
 * The people a v2 policy explicitly names on an allow rule of this scope (first appearance order, distinct, at most `limit`): the display hint
 * the installer's refusal gives its file owner, who may read these files anyway. Nothing here grants anything; `all` principals are skipped.
 */
export function policyNamedPeople(current: unknown, scopeId: string, limit: number): readonly Person[] {
  const parsed = policyFileSchema.safeParse(current);
  if (!parsed.success || parsed.data.schemaVersion !== 2) return Object.freeze([]);
  const people: Person[] = [];
  for (const grant of parsed.data.grants) {
    if (grant.effect !== 'allow' || grant.principals === 'all' || grant.scopes === 'all' || !grant.scopes.includes(scopeId)) continue;
    for (const item of grant.principals) {
      if (isWorkloadPrincipalRef(item)) continue;
      if (people.length >= limit) return Object.freeze(people);
      if (!people.some(held => held.issuer === item.issuer && held.subject === item.subject)) people.push(Object.freeze({ issuer: item.issuer, subject: item.subject }));
    }
  }
  return Object.freeze(people);
}
