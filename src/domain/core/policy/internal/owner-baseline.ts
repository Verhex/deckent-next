import { isAiPrincipal } from '#domain/core/principal/index.js';
import { identitySchema } from '#domain/core/primitives/index.js';
import { anchorsPerson, namesPerson, policyNamedPeople } from './first-run-template.js';
import { aiAuthorityFloor } from './ai-floor.js';
import { evaluatePolicy } from './evaluate.js';
import { POLICY_CHANGE_MAX } from './administer.js';
import { policyFileSchema, policyGrantSchema, resolvePolicyBindings, type PolicyGrant } from './schema.js';
import { sameMcpCapabilityRule } from './mcp-capabilities.js';

export const OWNER_BASELINE_FAMILIES = ['mcp-delegable', 'decision-steps'] as const;
export const OWNER_BASELINE_PREFIX = 'owner-baseline-';
type Person = { readonly issuer: string; readonly subject: string };
export interface OwnerBaselineCell { readonly family: typeof OWNER_BASELINE_FAMILIES[number]; readonly kind: string; readonly actions: readonly string[];
  readonly ids: 'all' | readonly string[]; readonly scope: 'selected' | 'installation' }
export interface OwnerBaselineState { readonly id: string; readonly kind: string; readonly actions: readonly string[]; readonly ids: 'all' | readonly string[];
  readonly scopes: 'all' | readonly string[]; readonly before: string; readonly after: string }
export interface OwnerBaselinePlan {
  readonly status: 'plan' | 'current' | 'unavailable' | 'refused'; readonly reason?: 'not-first-run' | 'not-this-person' | 'person-not-named' | 'invalid' | 'rule-conflict' | 'policy-refused';
  readonly basis: 'first-run' | 'named-person' | null; readonly people: readonly Person[]; readonly cells: readonly OwnerBaselineState[];
  readonly added: readonly PolicyGrant[]; readonly removed: readonly string[]; readonly conflicts: readonly string[]; readonly remaining: number; readonly policy: unknown;
}
/** Person-only, add-only managed family; registries supply the cells, not a template version or an evaluator exception. */
export function planOwnerBaseline(policyDocument: unknown, bindings: unknown, input: { readonly person: Person; readonly explicit: boolean; readonly scopeId: string;
  readonly families: readonly string[]; readonly candidates: readonly OwnerBaselineCell[]; readonly peopleLimit: number; readonly digest: (text: string) => string }): OwnerBaselinePlan {
  const result = (status: OwnerBaselinePlan['status'], extra: Partial<OwnerBaselinePlan> = {}): OwnerBaselinePlan =>
    ({ status, basis: null, people: [], cells: [], added: [], removed: [], conflicts: [], remaining: 0, policy: policyDocument, ...extra });
  const parsed = policyFileSchema.safeParse(policyDocument), scope = identitySchema.safeParse(input.scopeId);
  if (!parsed.success || parsed.data.schemaVersion !== 2 || !scope.success || !identitySchema.safeParse(input.person.issuer).success
    || !identitySchema.safeParse(input.person.subject).success || new Set(input.families).size !== input.families.length
    || input.families.some(family => !(OWNER_BASELINE_FAMILIES as readonly string[]).includes(family))) return result('unavailable', { reason: 'invalid' });
  const person = input.person, grants = parsed.data.grants, scopeId = scope.data;
  if (isAiPrincipal({ ...person, assurance: 'os-user' })) return result('unavailable', { reason: 'not-this-person' });
  const read = grants.find(rule => rule.id === 'first-run-read-tools' && rule.scopes !== 'all');
  let basis: OwnerBaselinePlan['basis'];
  if (read) {
    if (!namesPerson(read, person) || read.scopes === 'all' || !read.scopes.includes(scopeId)) return result('unavailable', { reason: 'not-this-person' });
    basis = 'first-run';
  } else {
    if (!input.explicit || !grants.some(rule => anchorsPerson(rule, person, scopeId))) return result('unavailable', { reason: input.explicit ? 'person-not-named' : 'not-first-run', people: policyNamedPeople(parsed.data, scopeId, input.peopleLimit) });
    basis = 'named-person';
  }
  let current; try { current = resolvePolicyBindings(policyDocument, bindings); } catch { return result('unavailable', { reason: 'invalid' }); }
  const principal = { id: 'owner-baseline-plan', ...person, assurance: 'os-user' as const, scopeIds: [scopeId] };
  const request = (rule: PolicyGrant, action: string, id: string, scopeId: string) => ({ principal, scopeId, action, resource: { kind: rule.resource.kind, id } });
  const covers = (held: PolicyGrant, want: PolicyGrant) => held.effect === 'allow' && held.resource.kind === want.resource.kind
    && (held.principals === 'all' || namesPerson(held, person))
    && (held.actions === 'all' || want.actions !== 'all' && want.actions.every(action => held.actions.includes(action)))
    && (held.scopes === 'all' || want.scopes !== 'all' && want.scopes.every(scope => held.scopes.includes(scope)))
    && (held.resource.ids === 'all' || want.resource.ids !== 'all' && want.resource.ids.every(id => held.resource.ids.includes(id)));
  const wanted = input.candidates.filter(cell => input.families.includes(cell.family)).flatMap(cell => {
    if (['agent-tool', 'agent-tool-call', 'mcp-server'].includes(cell.kind)) return [];
    const ids = cell.ids === 'all' ? ['owner-baseline-target'] : cell.ids;
    const actions = cell.actions.filter(action => !ids.some(id => aiAuthorityFloor({ issuer: 'mcp' }, { kind: cell.kind, id }, action)));
    if (!actions.length || !ids.length) return [];
    const id = `${OWNER_BASELINE_PREFIX}${cell.family}-${input.digest(JSON.stringify([cell.kind, actions, cell.ids, cell.scope])).slice(0, 16)}`;
    return [policyGrantSchema.parse({ id, effect: 'allow', principals: [person], scopes: cell.scope === 'installation' ? 'all' : [scopeId],
      actions, resource: { kind: cell.kind, ids: cell.ids } })];
  });
  const conflicts = wanted.filter(want => grants.some(held => held.id === want.id && !sameMcpCapabilityRule(held, want))).map(rule => rule.id);
  const missing = [...new Map(wanted.filter(want => !grants.some(held => covers(held, want))).map(rule => [rule.id, rule])).values()];
  const added = missing.slice(0, POLICY_CHANGE_MAX);
  // Removal is scoped to this person's managed rules in this scope; custom and other people's rules remain untouched.
  const owned = input.families.length ? [] : grants.filter(rule => rule.id.startsWith(OWNER_BASELINE_PREFIX) && rule.principals !== 'all'
    && rule.principals.length === 1 && namesPerson(rule, person) && (rule.scopes === 'all' || rule.scopes.length === 1 && rule.scopes[0] === scopeId));
  const modified = owned.filter(rule => rule.effect !== 'allow' || rule.actions === 'all' || !OWNER_BASELINE_FAMILIES.some(family =>
    rule.id === `${OWNER_BASELINE_PREFIX}${family}-${input.digest(JSON.stringify([rule.resource.kind, rule.actions, rule.resource.ids, rule.scopes === 'all' ? 'installation' : 'selected'])).slice(0, 16)}`));
  if (modified.length) return result('refused', { basis, reason: 'rule-conflict', conflicts: modified.map(rule => rule.id) });
  const removed = owned.slice(0, POLICY_CHANGE_MAX).map(rule => rule.id);
  const next = { ...(policyDocument as object), grants: [...(policyDocument as { grants: PolicyGrant[] }).grants.filter(rule => !removed.includes(rule.id)), ...added] };
  const after = resolvePolicyBindings(next, bindings);
  const cells = wanted.map(rule => {
    const decisions = (policy: typeof current) => (rule.actions === 'all' ? [] : rule.actions).flatMap(action =>
      (rule.resource.ids === 'all' ? ['owner-baseline-target'] : rule.resource.ids).map(id => evaluatePolicy(policy, request(rule, action, id, scopeId)).decision));
    const effect = (values: readonly string[]) => values.every(value => value === 'allow') ? 'allow' : values.includes('deny') ? 'deny' : 'require-approval';
    return { id: rule.id, kind: rule.resource.kind, actions: rule.actions === 'all' ? [] : rule.actions, ids: rule.resource.ids, scopes: rule.scopes,
      before: effect(decisions(current)), after: effect(decisions(after)) };
  });
  if (conflicts.length || cells.some(cell => added.some(rule => rule.id === cell.id) && cell.after !== 'allow')) return result('refused', { basis, reason: conflicts.length ? 'rule-conflict' : 'policy-refused', conflicts, cells });
  return result(added.length || removed.length ? 'plan' : 'current', { basis, cells, added, removed, conflicts, remaining: Math.max(0, missing.length - added.length) + Math.max(0, owned.length - removed.length), policy: next });
}
