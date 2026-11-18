import { expect, it } from 'vitest';
import { planPolicyChange, policyChangeSchema, resolvePolicyBindings, delegationWithin, describePolicyChange } from '#domain/index.js';
import { t } from '#platform/index.js';

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

it('119-C2-P: stably puts AI permission additions and uncertain widenings first, preserving pure narrowing and removal order', () => {
  const ai = { issuer: 'directory/mcp', subject: 'member' };
  const grant = { ...policy.grants[0]!, principals: [ai], actions: ['inspect', 'cancel'] };
  const previous = { ...policy, roles: [role], grants: [{ ...grant, id: 'narrow' }, { ...grant, id: 'widen', actions: ['inspect'] }] };
  const bound = { ...addBinding.binding, principals: [ai] };
  const input = change([
    { kind: 'grant.add', grant: { ...grant, id: 'human', principals: [actor] } },
    { kind: 'grant.replace', grant: { ...grant, id: 'narrow', actions: ['inspect'] } },
    { kind: 'grant.remove', id: 'narrow' },
    { kind: 'grant.add', grant: { ...grant, id: 'denial', effect: 'deny' } },
    { kind: 'grant.replace', grant: { ...grant, id: 'widen' } },
    { kind: 'binding.add', binding: bound },
    { kind: 'role.add', role: { ...role, id: 'new-ai-role' } },
    { kind: 'binding.add', binding: { ...bound, id: 'new-ai-binding', roles: ['new-ai-role'] } },
    { kind: 'grant.add', grant: { ...grant, id: 'ask', effect: 'require-approval' } },
  ]);
  const described = describePolicyChange({ policy: previous, bindings }, input)!;
  const ids = described.split('\n').slice(1).map(line => line.split(':')[0]);
  expect(ids).toEqual(['~ grant widen', '+ binding selected-member', '+ role new-ai-role', '+ binding new-ai-binding', '+ grant ask',
    '+ grant human', '~ grant narrow', '- grant narrow', '+ grant denial']);
  expect(describePolicyChange({ policy: previous, bindings }, input)).toBe(described);
});

it('119-C2-P: detects MCP-specific and mode widenings, and binding narrowing; budgets count a partial Unicode line once', () => {
  const ai = { issuer: 'directory/mcp', subject: 'member' };
  const grant = { ...policy.grants[0]!, principals: [ai], effect: 'require-approval' };
  const old = { ...policy, roles: [role], grants: [{ ...grant, id: 'generic', effect: 'allow', principals: 'all' }, { ...grant, id: 'mode' },
    { ...grant, id: 'allow', effect: 'allow' }, { ...grant, id: 'ask-all', principals: 'all' }, { ...grant, id: 'allow-all', effect: 'allow', principals: 'all' }] };
  const binding = { ...addBinding.binding, principals: [ai], scopes: ['s', 'other'] };
  const before = { ...bindings, bindings: [binding] };
  const input = change([
    { kind: 'binding.replace', binding: { ...binding, scopes: ['s'] } },
    { kind: 'grant.replace', grant: { ...grant, id: 'allow' } },
    { kind: 'grant.replace', grant: { ...grant, id: 'ask-all' } },
    { kind: 'grant.replace', grant: { ...grant, id: 'allow-all', principals: 'all' } },
    { kind: 'grant.replace', grant: { ...grant, id: 'generic', effect: 'allow' } },
    { kind: 'grant.replace', grant: { ...grant, id: 'mode', modeEligible: true } },
    { kind: 'binding.add', binding: { ...binding, id: 'unresolved', roles: ['unknown'] } },
  ]);
  expect(describePolicyChange({ policy: old, bindings: before }, input)!.split('\n').slice(1).map(line => line.split(':')[0])).toEqual([
    '~ grant allow-all', '~ grant generic', '~ grant mode', '+ binding unresolved', '~ binding selected-member', '~ grant allow', '~ grant ask-all',
  ]);
  const long = change([{ kind: 'role.add', role: { id: 'huge', permissions: Array.from({ length: 60 }, (_, i) => ({
    ...role.permissions[0]!, id: `p-${i}`, resource: { kind: 'run', ids: ['😀'.repeat(48)] },
  })) } }]);
  for (const budget of [0, 16, 128, 512, 2048]) {
    const description = describePolicyChange({ policy, bindings }, long, { budget, elision: count => t('policy.change.elision', { count }, 'en') })!;
    expect(description.length).toBeLessThanOrEqual(budget);
    expect(description.isWellFormed()).toBe(true);
    if (budget >= 128) expect(description).toContain('This card does not show 1 of the changes in full.');
  }
});
