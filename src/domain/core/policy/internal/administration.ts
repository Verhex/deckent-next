import { APPROVAL_ASSURANCE } from '#domain/core/approval/index.js';
import { isMcpPrincipal } from '#domain/core/principal/index.js';
import { includes, policySchema, principalGrants, type Policy } from './schema.js';

type Person = { readonly issuer: string; readonly subject: string };
const REST = Symbol('remaining-scopes');
type Scope = string | typeof REST;
const inScope = (scopes: 'all' | readonly string[], scope: Scope) => scopes === 'all' || (scope !== REST && scopes.includes(scope));
/** Availability is supplied by the installation's decision producers. Unknown levels never imply reachable approval authority. */
export type AdministrationAssurance = (minimum: string) => boolean;
const coreAssurance: AdministrationAssurance = minimum => minimum === APPROVAL_ASSURANCE.peerSession;
export class PolicyLastAdminError extends Error {
  readonly code = 'POLICY_LAST_ADMIN';
  constructor() { super('POLICY_LAST_ADMIN'); this.name = 'PolicyLastAdminError'; }
}
function people(policy: Policy): readonly Person[] {
  const refs = [...policy.grants.flatMap(rule => rule.principals === 'all' ? [] : rule.principals),
    ...(policy.schemaVersion === 2 ? policy.bindings.entries.flatMap(entry => entry.principals) : [])];
  return refs.filter((ref, index) => !isMcpPrincipal(ref) && refs.findIndex(other => other.issuer === ref.issuer && other.subject === ref.subject) === index);
}
function authority(policy: Policy, person: Person, scope: Scope, kind: string, action: string, id: string | null): boolean {
  const own = (rule: { readonly principals: 'all' | readonly Person[] }) => rule.principals === 'all'
    || rule.principals.some(ref => ref.issuer === person.issuer && ref.subject === person.subject);
  const matches = (rule: { readonly scopes: 'all' | readonly string[]; readonly actions: 'all' | readonly string[]; readonly resource: { readonly kind: string; readonly ids: 'all' | readonly string[] } }) =>
    inScope(rule.scopes, scope) && includes(rule.actions, action) && rule.resource.kind === kind && (id === null || includes(rule.resource.ids, id));
  const grants = principalGrants(policy, person).filter(own);
  if (policy.restrictions.some(rule => own(rule) && matches(rule)) || grants.some(rule => rule.effect === 'deny' && matches(rule))) return false;
  if (id === null && grants.some(rule => rule.effect === 'require-approval' && matches(rule))) return false;
  return grants.some(rule => matches(rule) && (id === null ? rule.effect === 'allow' && rule.resource.ids === 'all' : rule.effect !== 'deny'));
}
function admins(policy: Policy, scope: Scope, assurance: AdministrationAssurance): readonly Person[] {
  if (policy.schemaVersion === 2 && policy.approvalAssurance?.some(rule => rule.subject === 'operation' && inScope(rule.scopes, scope)
    && (!rule.effectClasses || rule.effectClasses.includes('write')) && !assurance(rule.minimum))) return [];
  const candidates = people(policy), requesters = candidates.filter(person => authority(policy, person, scope, 'operation', 'execute', 'policy.administer'));
  const separate = policy.schemaVersion === 2 && policy.separationOfDuties.some(rule => inScope(rule.scopes, scope));
  return requesters.filter(person => authority(policy, person, scope, 'approval', 'inspect', null) && authority(policy, person, scope, 'approval', 'decide', null)
    && (!separate || requesters.some(other => other.issuer !== person.issuer || other.subject !== person.subject)));
}
/** Exact policy-capable named principals, never proof of external directory activity, terminal presence or host custody. Modes grant no authority. */
export function usablePolicyAdmins(input: unknown, scopeId: string, assurance: AdministrationAssurance = coreAssurance): readonly Person[] {
  return Object.freeze(admins(policySchema.parse(input), scopeId, assurance).map(person => Object.freeze({ ...person })));
}
/** Protect every previously administered scope partition, including the remainder of wildcard scopes. Existing headless policies can be repaired. */
export function assertPolicyAdministrationPreserved(beforeInput: unknown, afterInput: unknown, assurance: AdministrationAssurance = coreAssurance): void {
  const before = policySchema.parse(beforeInput), after = policySchema.parse(afterInput);
  const scopes = (policy: Policy) => [...policy.grants, ...policy.restrictions,
    ...(policy.schemaVersion === 2 ? [...policy.bindings.entries, ...policy.separationOfDuties, ...policy.approvalAssurance ?? []] : [])]
    .flatMap(rule => rule.scopes === 'all' ? [] : rule.scopes);
  const partitions: Scope[] = [...new Set([...scopes(before), ...scopes(after)]), REST];
  for (const scope of partitions) {
    if (admins(before, scope, assurance).length && !admins(after, scope, assurance).length) throw new PolicyLastAdminError();
  }
}
