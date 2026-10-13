import { APPROVAL_ASSURANCE } from '#domain/core/approval/index.js';
import { isMcpPrincipal } from '#domain/core/principal/index.js';
import { evaluatePolicy } from './evaluate.js';
import { includes, policySchema, principalGrants, type Policy, type PolicyRule } from './schema.js';

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
/** A witness outside every finite selector represents its remaining equivalence class, without randomness or a reserved policy id. */
function remaining(values: readonly string[]): string {
  const used = new Set(values); let index = used.size;
  while (used.has(String(index))) index++;
  return String(index);
}
const scopes = (policy: Policy) => [...policy.grants, ...policy.restrictions,
  ...(policy.schemaVersion === 2 ? [...policy.bindings.entries, ...policy.separationOfDuties, ...policy.approvalAssurance ?? []] : [])]
  .flatMap(rule => rule.scopes === 'all' ? [] : rule.scopes);
function approvalId(policy: Policy): string {
  const rules = [...policy.grants, ...policy.restrictions, ...(policy.schemaVersion === 2 ? policy.roles.flatMap(role => role.permissions) : [])];
  return remaining(rules.filter(rule => rule.resource.kind === 'approval').flatMap(rule => rule.resource.ids === 'all' ? [] : rule.resource.ids));
}
function authority(policy: Policy, person: Person, scope: Scope, kind: string, action: string, id: string): boolean {
  const scopeId = scope === REST ? remaining(scopes(policy)) : scope;
  // Capability probe only: this does not attest a person, session, directory activity or terminal custody.
  const decision = evaluatePolicy(policy, { principal: { ...person, id: person.subject, assurance: 'os-user', scopeIds: [scopeId] },
    scopeId, action, resource: { kind, id } }).decision;
  return kind === 'operation' ? decision !== 'deny' : decision === 'allow';
}
function admins(policy: Policy, scope: Scope, assurance: AdministrationAssurance): readonly Person[] {
  if (policy.schemaVersion === 2 && policy.approvalAssurance?.some(rule => rule.subject === 'operation' && inScope(rule.scopes, scope)
    && (!rule.effectClasses || rule.effectClasses.includes('write')) && !assurance(rule.minimum))) return [];
  const candidates = people(policy), requesters = candidates.filter(person => authority(policy, person, scope, 'operation', 'execute', 'policy.administer'));
  const separate = policy.schemaVersion === 2 && policy.separationOfDuties.some(rule => inScope(rule.scopes, scope));
  const fresh = approvalId(policy);
  return requesters.filter(person => authority(policy, person, scope, 'approval', 'inspect', fresh) && authority(policy, person, scope, 'approval', 'decide', fresh)
    && (!separate || requesters.some(other => other.issuer !== person.issuer || other.subject !== person.subject)));
}
/** Headless repair is add-only authority. Changed rules whose monotonicity is not proven fail closed, even if the admin count is zero. */
function headlessRepair(before: Policy, after: Policy, scope: Scope): boolean {
  const relevant = (rule: PolicyRule) => inScope(rule.scopes, scope) && (rule.resource.kind === 'approval'
    ? includes(rule.actions, 'inspect') || includes(rule.actions, 'decide')
    : rule.resource.kind === 'operation' && includes(rule.actions, 'execute') && includes(rule.resource.ids, 'policy.administer'));
  const signature = (rule: PolicyRule & { readonly effect?: string }) => JSON.stringify({ principals: rule.principals, effect: rule.effect,
    actions: rule.resource.kind === 'approval' ? ['inspect', 'decide'].filter(action => includes(rule.actions, action)) : ['execute'],
    resource: rule.resource.kind === 'approval' ? rule.resource : { kind: 'operation', ids: ['policy.administer'] } });
  const projection = (policy: Policy) => {
    const grants = [...policy.grants, ...people(policy).flatMap(person => principalGrants(policy, person))].filter(relevant);
    const positive = new Set(grants.filter(rule => rule.effect !== 'deny').map(signature));
    const negative = new Set([...grants.filter(rule => rule.effect !== 'allow'), ...policy.restrictions.filter(relevant)].map(signature));
    if (policy.schemaVersion === 2) {
      for (const rule of [...policy.separationOfDuties, ...policy.approvalAssurance ?? []]) {
        if (inScope(rule.scopes, scope) && (!('subject' in rule) || rule.subject === 'operation' && (!rule.effectClasses || rule.effectClasses.includes('write')))) {
          negative.add(JSON.stringify(Object.fromEntries(Object.entries(rule).filter(([key]) => key !== 'id' && key !== 'scopes'))));
        }
      }
    }
    return { positive, negative };
  };
  const old = projection(before), next = projection(after);
  return [...old.positive].every(rule => next.positive.has(rule)) && [...next.negative].every(rule => old.negative.has(rule));
}
/** Exact policy-capable named principals, never proof of external directory activity, terminal presence or host custody. Modes grant no authority. */
export function usablePolicyAdmins(input: unknown, scopeId: string, assurance: AdministrationAssurance = coreAssurance): readonly Person[] {
  return Object.freeze(admins(policySchema.parse(input), scopeId, assurance).map(person => Object.freeze({ ...person })));
}
/** Protect each scope partition, including wildcard remainders. Zero/unknown before authority never exempts a reduction; headless repair stays open. */
export function assertPolicyAdministrationPreserved(beforeInput: unknown, afterInput: unknown, assurance: AdministrationAssurance = coreAssurance): void {
  const before = policySchema.parse(beforeInput), after = policySchema.parse(afterInput);
  const partitions: Scope[] = [...new Set([...scopes(before), ...scopes(after)]), REST];
  for (const scope of partitions) {
    const previous = admins(before, scope, assurance).length;
    if (previous ? !admins(after, scope, assurance).length : !headlessRepair(before, after, scope)) throw new PolicyLastAdminError();
  }
}
