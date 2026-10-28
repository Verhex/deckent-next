import { bindingsFileSchema, policyFileSchema, policyNamedPeople, resolvePolicyBindings, upgradeBindingsDocument,
  type PolicyBinding } from '#domain/index.js';
import { beuserEvaluatorPrincipalRef, isWorkloadPrincipalRef } from '#domain/index.js';
import { identitySchema } from '#domain/index.js';
import { chainAuthorityRevision, type AuthorityHistorySource, type AuthorityDocumentStore, type AuthorityRevision } from '#engine/core/policy/index.js';
import { loadSystemPolicyRows, systemPolicyCanonical, systemPolicyDigest, type SystemPolicyRows } from './registry.js';

export type SystemPolicyRowsStore = AuthorityDocumentStore & AuthorityHistorySource;
export interface SystemPolicyRowsTarget { readonly scopeId: string; readonly person: { readonly issuer: string; readonly subject: string } }
export interface SystemPolicyRowsPlan {
  readonly status: 'preview' | 'current' | 'conflict' | 'unavailable'; readonly reason: string | null;
  readonly key: string; readonly prefix: string; readonly revision: string; readonly packageDigest: string;
  readonly next: { readonly policy: unknown; readonly bindings: unknown } | null;
  readonly conflicts: readonly string[]; readonly withheld: readonly string[];
}
const same = (a: unknown, b: unknown) => systemPolicyCanonical(a) === systemPolicyCanonical(b);
/** Scope+person isolate role ids; data never carries a principal, filesystem path or installing identity. */
export function bindSystemPolicyRows(input: unknown, target: SystemPolicyRowsTarget) {
  const pack = loadSystemPolicyRows(input), scopeId = identitySchema.parse(target.scopeId);
  const person = { issuer: identitySchema.parse(target.person.issuer), subject: identitySchema.parse(target.person.subject) };
  if (isWorkloadPrincipalRef(person)) throw new Error('SYSTEM_POLICY_ROWS_PERSON_INVALID');
  const context = systemPolicyDigest({ id: pack.data.id, scopeId, person }).slice(0, 32);
  const prefix = `spr1-${context}-`, name = (id: string) => `sr-${context}-${id}`;
  const roles = pack.data.roles.map(role => ({ ...role, id: name(role.id) }));
  const bindings: readonly PolicyBinding[] = pack.data.bindings.map(binding => ({ id: name(binding.id), principals: [beuserEvaluatorPrincipalRef(person)], scopes: [scopeId], roles: binding.roles.map(name) }));
  return { ...pack, scopeId, person, prefix, key: `${prefix}${pack.digest.slice(0, 32)}`, roles, bindings };
}
/** Read provenance from the existing authority archive, whose owner/byte limits and trust checks are shared with policy.administer. */
function additions(entry: AuthorityRevision) {
  if (entry.before.schemaVersion !== 2 || entry.after.schemaVersion !== 2) return { roles: [], permissions: [], bindings: [] };
  const before = entry.before, after = entry.after;
  return { roles: after.roles.filter(role => !before.roles.some(held => held.id === role.id)).map(role => role.id),
    permissions: after.roles.flatMap(role => role.permissions.filter(permission => !before.roles.find(held => held.id === role.id)?.permissions.some(held => held.id === permission.id))
      .map(permission => ({ roleId: role.id, permission }))),
    bindings: after.bindings.entries.filter(binding => !before.bindings.entries.some(held => held.id === binding.id)) };
}
/** The single pure install/upgrade/rollback planner. No read/startup consumer applies it implicitly. */
export function planSystemPolicyRows(input: { readonly data: SystemPolicyRows; readonly target: SystemPolicyRowsTarget;
  readonly snapshot: { readonly policy: unknown; readonly bindings: unknown }; readonly history: readonly AuthorityRevision[];
  readonly action: 'apply' | 'rollback' }): SystemPolicyRowsPlan {
  const bound = bindSystemPolicyRows(input.data, input.target), { snapshot } = input;
  const policy = policyFileSchema.parse(snapshot.policy), bindings = bindingsFileSchema.parse(snapshot.bindings);
  const effective = resolvePolicyBindings(policy, bindings), revision = effective.revision;
  const result = (status: SystemPolicyRowsPlan['status'], extra: Partial<SystemPolicyRowsPlan> = {}): SystemPolicyRowsPlan => Object.freeze({ status,
    reason: null, key: input.action === 'apply' ? bound.key : bound.key.replace('spr1-', 'srr1-'), prefix: bound.prefix, revision,
    packageDigest: bound.digest, next: null, conflicts: [], withheld: [], ...extra });
  if (policy.schemaVersion !== 2 || effective.schemaVersion !== 2) return result('unavailable', { reason: 'policy-version' });
  const named = policyNamedPeople(policy, bound.scopeId, policy.grants.length + effective.bindings.entries.length + 1);
  if (!named.some(person => same(person, bound.person))) return result('unavailable', { reason: 'person-not-named' });
  const previous = input.history.filter(entry => entry.key?.startsWith(bound.prefix));
  const ever = previous.map(additions), withheld: string[] = [], conflicts: string[] = [];
  let roles = [...policy.roles], entries = [...bindings.bindings];
  if (input.action === 'apply') {
    for (const role of bound.roles) {
      const held = roles.find(row => row.id === role.id);
      if (!held) {
        if (ever.some(entry => entry.roles.includes(role.id))) { withheld.push(role.id); continue; }
        roles.push(role); continue;
      }
      const permissions = [...held.permissions];
      for (const permission of role.permissions) {
        const old = permissions.find(row => row.id === permission.id);
        if (old) { if (!same(old, permission)) conflicts.push(`${role.id}/${permission.id}`); continue; }
        if (ever.some(entry => entry.permissions.some(row => row.roleId === role.id && row.permission.id === permission.id))) withheld.push(`${role.id}/${permission.id}`);
        else permissions.push(permission);
      }
      // An unowned same-id role (even with extra permissions) is never implicitly adopted into the system binding.
      if (!previous.length && !same(held, role) || held.permissions.some(permission => !role.permissions.some(row => row.id === permission.id)
        && !previous.some(entry => entry.after.schemaVersion === 2 && entry.after.roles.some(row => row.id === role.id && row.permissions.some(old => same(old, permission)))))) conflicts.push(role.id);
      roles = roles.map(row => row.id === role.id ? { ...row, permissions } : row);
    }
    for (const binding of bound.bindings) {
      const held = entries.find(row => row.id === binding.id);
      if (held) { if (!same(held, binding)) conflicts.push(binding.id); continue; }
      // A policy-first crash may leave identical roles without bindings and no committed history. Never complete it under another data key.
      if (!previous.length && binding.roles.some(id => policy.roles.some(role => role.id === id))) { conflicts.push(binding.id); continue; }
      if (ever.some(entry => entry.bindings.some(row => row.id === binding.id)) || binding.roles.some(id => !roles.some(row => row.id === id))) { withheld.push(binding.id); continue; }
      entries.push(binding);
    }
  } else {
    const applied = input.history.find(entry => entry.key === bound.key);
    if (!applied) return result('unavailable', { reason: 'journal-unavailable' });
    const owned = additions(applied);
    entries = entries.filter(binding => !owned.bindings.some(row => same(row, binding)));
    roles = roles.flatMap(role => {
      // A person may have bound the role elsewhere since installation; preserve that responsibility.
      if (entries.some(binding => binding.roles.includes(role.id))) return [role];
      const permissions = role.permissions.filter(permission => !owned.permissions.some(row => row.roleId === role.id && same(row.permission, permission)));
      return permissions.length ? [{ ...role, permissions }] : [];
    });
  }
  if (conflicts.length) return result('conflict', { reason: 'customized-id', conflicts: Object.freeze(conflicts), withheld: Object.freeze(withheld) });
  const policyChanged = !same(roles, policy.roles), bindingsChanged = !same(entries, bindings.bindings);
  if (!policyChanged && !bindingsChanged) return result('current', { withheld: Object.freeze(withheld) });
  const nextPolicy = policyChanged ? { ...policy, roles, revision: chainAuthorityRevision('system-policy-rows', 'a', policy.revision, roles) } : policy;
  const nextBindings = bindingsChanged ? { ...upgradeBindingsDocument(bindings), bindings: entries,
    revision: chainAuthorityRevision('system-policy-rows', 'a', bindings.revision, entries) } : bindings;
  resolvePolicyBindings(nextPolicy, nextBindings);
  // Both intermediate states must resolve; removal publishes bindings first, additions policy first.
  resolvePolicyBindings(input.action === 'apply' ? nextPolicy : policy, input.action === 'apply' ? bindings : nextBindings);
  return result('preview', { next: Object.freeze({ policy: nextPolicy, bindings: nextBindings }), withheld: Object.freeze(withheld) });
}
