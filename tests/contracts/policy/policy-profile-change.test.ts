import { expect, it } from 'vitest';
import { planPolicyChange, policyChangeSchema, resolvePolicyBindings, delegationWithin, describePolicyChange } from '#domain/index.js';

const actor = { issuer: 'fixture', subject: 'admin' };
const role = { id: 'selected-reader', permissions: [{ id: 'inspect', effect: 'allow', actions: ['inspect'], resource: { kind: 'run', ids: 'all' } }] };
const policy = { schemaVersion: 2, revision: 'p1', roles: [], grants: [{ id: 'owned-read', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [actor], resource: { kind: 'run', ids: 'all' } }], restrictions: [], separationOfDuties: [] };
const bindings = { schemaVersion: 3, revision: 'b1', modes: [], bindings: [] };
const provenance = { id: 'core:team', version: 1, digest: '1'.repeat(64), registryDigest: '2'.repeat(64), previewDigest: '3'.repeat(64) };
const addRole = { kind: 'role.add', role };
const addBinding = { kind: 'binding.add', binding: { id: 'selected-member', principals: [{ issuer: 'directory', subject: 'member' }], roles: [role.id], scopes: ['s'] } };
const change = (changes: unknown[]) => ({ schemaVersion: 2, profile: provenance, changes });

it('v1 remains strict; v2 role creation produces valid intermediate documents and delegates only actual binding permissions', () => {
  expect(policyChangeSchema.safeParse({ schemaVersion: 1, changes: [addRole] }).success).toBe(false);
  const standalone = planPolicyChange(policy, bindings, change([addRole]));
  expect(standalone.touched).toEqual([]); expect(standalone.bindings).toBeNull();
  const plan = planPolicyChange(policy, bindings, change([addRole, addBinding]));
  expect(plan.order).toBe('policy-first'); expect(plan.touched).toMatchObject([{ scopes: ['s'], actions: ['inspect'] }]);
  expect(delegationWithin(resolvePolicyBindings(policy, bindings), actor, plan.touched)).toEqual({ ok: true });
  expect(resolvePolicyBindings({ ...plan.policy, revision: 'next' }, bindings)).toBeDefined();
  expect(resolvePolicyBindings({ ...plan.policy, revision: 'next' }, { ...plan.bindings, revision: 'next' })).toBeDefined();
  expect(describePolicyChange({ policy, bindings }, change([addRole, addBinding]))).toContain('+ role selected-reader: inspect allow run* actions[inspect]');
});
it('role additions plus selected binding removal preserve valid intermediate snapshots and untouched modes/SoD', () => {
  const oldRole = { ...role, id: 'old-reader' }, previous = { ...policy, roles: [oldRole], separationOfDuties: [{ id: 'two', scopes: ['s'], rule: 'requester-cannot-approve' }] };
  const prior = { ...bindings, bindings: [{ ...addBinding.binding, id: 'old', roles: ['old-reader'] }], modes: [{ id: 'mode', principal: actor, scopes: ['s'], mode: 'full-auto' }] };
  const plan = planPolicyChange(previous, prior, change([addRole, { kind: 'binding.remove', id: 'old' }, addBinding]));
  expect(plan.order).toBe('policy-first'); expect(plan.policy?.separationOfDuties).toEqual(previous.separationOfDuties);
  expect(plan.bindings).toMatchObject({ modes: prior.modes });
  expect(resolvePolicyBindings({ ...plan.policy, revision: 'next' }, prior)).toBeDefined();
  expect(resolvePolicyBindings({ ...plan.policy, revision: 'next' }, { ...plan.bindings, revision: 'next' })).toBeDefined();
});
it('refuses duplicate roles, unbound references, oversized changes and mixed grant revocation with a new role', () => {
  for (const changes of [[addRole, addRole], [addBinding, addRole], Array.from({ length: 33 }, () => addRole),
    [addRole, { kind: 'grant.remove', id: 'owned-read' }]]) {
    expect(() => planPolicyChange(policy, bindings, change(changes))).toThrowError(expect.objectContaining({ code: 'POLICY_CHANGE_INVALID' }));
  }
});
