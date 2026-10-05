import { describe, expect, it } from 'vitest';
import { IdentityProfileApplication, IdentityProfileRegistry } from '#engine/index.js';
import { coreIdentityProfileData, identityProfileDefinitionSchema, encodeIdentityProfile, resolvePolicyBindings, type IdentityPreviewInput } from '#domain/index.js';
import { sha256 } from '#platform/index.js';

const actor = { id: 'operator', issuer: 'local', subject: '1', assurance: 'os-user' as const, scopeIds: ['s'] };
const member = { id: 'member', label: 'Member', kind: 'human' as const, principal: { issuer: 'idp', subject: 'member' } };
const inspect = { id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind: 'scope', ids: ['s'] } };
const permission = { id: 'inspect', effect: 'allow', actions: ['inspect'], resource: { kind: 'run', ids: 'all' } };
function policy(overrides = {}, bindings: unknown[] = []) {
  return resolvePolicyBindings({ schemaVersion: 2, revision: 'p1', roles: [], grants: [inspect], restrictions: [], separationOfDuties: [], ...overrides },
    { schemaVersion: 3, revision: 'b1', bindings, modes: [] });
}
const input = (changes: Partial<IdentityPreviewInput> = {}): IdentityPreviewInput => ({ schemaVersion: 1, profile: { id: 'core:team', version: 1 }, scopeId: 's',
  members: [member], organization: [], assignments: [{ id: 'new-binding', memberId: member.id, roleId: 'profile-reader', scopeIds: ['s'] }], removeBindingIds: [], ...changes });
function app(current = policy(), principal = actor, registry = new IdentityProfileRegistry()) {
  return new IdentityProfileApplication(registry, { async load() { return { policy: current, principal, companyId: 'default', projectScopeIds: ['s'] }; } });
}
function custom() {
  const definition = { ...new IdentityProfileRegistry().resolve({ id: 'core:team', version: 1 }).definition, id: 'acme:review', labelKey: 'acme.profile.review' };
  return { schemaVersion: 1, namespace: 'acme', source: 'acme-profile-package', definition, digest: sha256(encodeIdentityProfile(definition)), labels: { en: 'Review', tr: 'İnceleme' } };
}
describe('identity profile registry data', () => {
  it('validates all four Core profiles through one schema and admits digest-bound extension versions without Core shadowing', () => {
    const registry = new IdentityProfileRegistry([custom()]);
    expect(registry.list().map(e => e.definition.id)).toEqual(['acme:review', 'core:custom', 'core:enterprise', 'core:solo', 'core:team']);
    expect(registry.list().every(e => identityProfileDefinitionSchema.safeParse(e.definition).success)).toBe(true);
    expect(registry.resolve({ id: 'acme:review', version: 1 }).namespace).toBe('acme');
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(Object.isFrozen(coreIdentityProfileData)).toBe(true);
    expect(Object.isFrozen(coreIdentityProfileData.profiles[0]?.defaults)).toBe(true);
    expect(Object.isFrozen(registry.list()[0]!.definition.roleTemplates[0]!.permissions)).toBe(true);
    expect(() => new IdentityProfileRegistry([{ ...custom(), namespace: 'core' }])).toThrowError('IDENTITY_PROFILE_SHADOW');
    expect(() => new IdentityProfileRegistry([custom(), custom()])).toThrowError('IDENTITY_PROFILE_SHADOW');
    expect(() => new IdentityProfileRegistry([{ ...custom(), digest: 'a'.repeat(64) }])).toThrowError('IDENTITY_PROFILE_DIGEST_MISMATCH');
    expect(new IdentityProfileRegistry().digest).not.toBe(registry.digest);
  });
  it.each([
    ['unknown:team', 1, 'IDENTITY_PROFILE_NAMESPACE_UNKNOWN'], ['core:unknown', 1, 'IDENTITY_PROFILE_UNKNOWN'], ['core:team', 2, 'IDENTITY_PROFILE_VERSION_UNKNOWN'],
  ])('refuses unknown identity %s version %s with a stable typed code', (id, version, code) => {
    expect(() => new IdentityProfileRegistry().resolve({ id: String(id), version: Number(version) })).toThrowError(String(code));
  });
  it('rejects future schemas, authority flags, duplicate roles and descriptor getters without invoking them', () => {
    const value = custom(); let invoked = false;
    expect(() => new IdentityProfileRegistry([{ ...value, definition: { ...value.definition, schemaVersion: 2 } }])).toThrow();
    expect(() => new IdentityProfileRegistry([{ ...value, definition: { ...value.definition, approvalPolicyTemplate: { adminApprovalRequired: false, secondPerson: 'disabled' } } }])).toThrow();
    expect(identityProfileDefinitionSchema.safeParse({ ...value.definition, roleTemplates: [value.definition.roleTemplates[0], value.definition.roleTemplates[0]] }).success).toBe(false);
    expect(() => new IdentityProfileRegistry([{ get definition() { invoked = true; return value.definition; } }])).toThrow();
    expect(invoked).toBe(false);
  });
});
it('produces stable read-only gains; binds every input, actor, profile, registry and authority revision into its digest', async () => {
  const current = policy(), bytes = JSON.stringify(current), application = app(current);
  const result = await application.preview(input()), repeat = await application.preview(input());
  expect(result).toEqual(repeat); expect(JSON.stringify(current)).toBe(bytes);
  expect(result.draft).toMatchObject({ state: 'draft', grantsAuthority: false, canApply: false, projectScopeIds: ['s'], futureProjects: { requested: false, applied: false } });
  expect(result.draft.members[0]?.verification).toBe('unverified');
  expect(result.differences).toContainEqual(expect.objectContaining({ change: 'gain', memberId: 'member', resourceIds: { except: [] }, before: expect.objectContaining({ decision: 'deny' }), after: expect.objectContaining({ decision: 'allow' }) }));
  expect(result.pins).toMatchObject({ policyRevision: 'p1', bindingsRevision: 'b1', registryVersion: 1, actor });
  expect((await application.preview(input({ includeFutureProjects: true }))).digest).not.toBe(result.digest);
  expect((await app(policy({ revision: 'p2' })).preview(input())).digest).not.toBe(result.digest);
  expect((await app(current, { ...actor, id: 'other-display' }).preview(input())).digest).not.toBe(result.digest);
  expect((await app(current, actor, new IdentityProfileRegistry([custom()])).preview(input())).digest).not.toBe(result.digest);
});
it('preserves denies and approval exceptions when comparing wildcard grants, including unchanged cells', async () => {
  const restrict = { id: 'deny-one', actions: ['inspect'], scopes: ['s'], principals: [member.principal], resource: { kind: 'run', ids: ['private'] } };
  const approval = { ...restrict, id: 'approval-one', effect: 'require-approval', resource: { kind: 'run', ids: ['review'] } };
  const result = await app(policy({ restrictions: [restrict], grants: [inspect, approval] })).preview(input());
  expect(result.differences.find(c => 'values' in c.resourceIds && c.resourceIds.values.includes('private'))).toMatchObject({ change: 'unchanged', after: { decision: 'deny', reason: 'DENIED' } });
  expect(result.differences.find(c => 'values' in c.resourceIds && c.resourceIds.values.includes('review'))).toMatchObject({ change: 'unchanged', after: { decision: 'require-approval' } });
  expect(result.differences.find(c => 'except' in c.resourceIds)).toMatchObject({ change: 'gain', resourceIds: { except: ['private', 'review'] } });
});
it('reports explicit losses while preserving unrelated bindings and company authority', async () => {
  const binding = { id: 'old', principals: [member.principal], roles: ['reader'], scopes: ['s'] };
  const current = policy({ roles: [{ id: 'reader', permissions: [permission] }] }, [binding, { ...binding, id: 'other', principals: [{ issuer: 'other', subject: '1' }] }]);
  const result = await app(current).preview(input({ assignments: [], removeBindingIds: ['old'] }));
  expect(result.differences[0]).toMatchObject({ change: 'loss', before: { decision: 'allow' }, after: { decision: 'deny' } });
  expect(result.unaffectedBindings).toBe(1); expect(result.draft.removedBindings).toEqual([binding]);
  expect(result.draft.preserved).toMatchObject({ grants: true, restrictions: true, permissionModes: true, separationOfDuties: true });
});
it('does not prune customization when selecting a different profile and never extends to future scopes', async () => {
  const current = policy({ roles: [{ id: 'existing', permissions: [permission] }] }, [{ id: 'custom-binding', principals: [member.principal], roles: ['existing'], scopes: ['s'] }]);
  const result = await app(current).preview(input({ profile: { id: 'core:solo', version: 1 }, assignments: [], includeFutureProjects: true }));
  expect(result.draft.addedBindings).toEqual([]); expect(result.draft.removedBindings).toEqual([]);
  expect(result.differences.every(c => c.change === 'unchanged')).toBe(true);
  expect(result.draft.futureProjects).toEqual({ requested: true, applied: false });
  expect(result.draft.projectScopeIds).toEqual(['s']);
});
it.each([
  { assignments: [{ id: 'new-binding', memberId: 'missing', roleId: 'profile-reader', scopeIds: ['s'] }] },
  { members: [member, member] }, { removeBindingIds: ['absent'] },
  { organization: [{ id: 'a', kind: 'unit', label: 'A', companyId: 'foreign', parentId: null }] },
  { organization: [{ id: 'a', kind: 'unit', label: 'A', companyId: 'default', parentId: 'a' }] },
  { organization: [{ id: 'a', kind: 'unit', label: 'A', companyId: 'default', parentId: 'missing' }] },
])('rejects invalid member, binding and hierarchy references: %j', async changes => {
  await expect(app().preview({ ...input(), ...changes })).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_INVALID' });
});
it('rejects cross-scope proposals, wildcard removal and role shadowing without relaxing scope inspection policy', async () => {
  await expect(app().preview(input({ projectScopeIds: ['s', 'foreign'] }))).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_SCOPE_DENIED' });
  await expect(app(policy({ grants: [{ ...inspect, effect: 'deny' }] })).preview(input())).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_SCOPE_DENIED' });
  await expect(app(policy({ roles: [{ id: 'profile-reader', permissions: [{ ...permission, effect: 'deny' }] }] })).preview(input())).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_CONFLICT' });
  const bound = policy({ roles: [{ id: 'reader', permissions: [permission] }] }, [{ id: 'wild', principals: [member.principal], roles: ['reader'], scopes: 'all' }]);
  await expect(app(bound).preview(input({ removeBindingIds: ['wild'] }))).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_SCOPE_DENIED' });
});
it('keeps missing adapters unresolved and emits no implied IdP or hierarchy authority', async () => {
  const value = custom(), definition = { ...value.definition, requires: [{ id: 'acme:directory', version: 1 }] };
  const registry = new IdentityProfileRegistry([{ ...value, definition, digest: sha256(encodeIdentityProfile(definition)) }]);
  const result = await app(policy(), actor, registry).preview(input({ profile: { id: 'acme:review', version: 1 } }));
  expect(result.draft.unresolvedRequirements).toEqual(definition.requires); expect(result.draft.canApply).toBe(false);
});
it('allows preserve-only v1 previews and refuses unavailable role simulation, malformed inputs and oversized comparisons', async () => {
  const old = resolvePolicyBindings({ schemaVersion: 1, revision: 'old', grants: [inspect], restrictions: [] }, null);
  expect((await app(old).preview(input({ assignments: [] }))).pins.bindingsRevision).toBeNull();
  await expect(app(old).preview(input())).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_UNAVAILABLE' });
  await expect(app().preview({ ...input(), grantsAuthority: true })).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_INVALID' });
  const broad = { ...inspect, id: 'broad', principals: [member.principal], actions: Array.from({ length: 129 }, (_, i) => `action-${i}`), resource: { kind: 'run', ids: Array.from({ length: 129 }, (_, i) => `id-${i}`) } };
  await expect(app(policy({ grants: [inspect, broad] })).preview(input())).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_LIMIT' });
});
it('preserves company approval and personal-mode records, never resolves an unknown member as a verified human, and freezes the digest-bound cells', async () => {
  const duty = { id: 'four-eyes', rule: 'requester-cannot-approve', scopes: ['s'] };
  const current = resolvePolicyBindings({ schemaVersion: 2, revision: 'p', roles: [], grants: [inspect], restrictions: [], separationOfDuties: [duty],
    approvalAssurance: [{ id: 'strong', scopes: ['s'], subject: 'operation', authority: true, minimum: 'peer-session' }] },
    { schemaVersion: 3, revision: 'b', bindings: [], modes: [{ id: 'mode', principal: member.principal, scopes: ['s'], mode: 'full-access' }] });
  let reads = 0;
  const application = new IdentityProfileApplication(new IdentityProfileRegistry(), { async load() { reads++; return { principal: actor, policy: current, projectScopeIds: ['s'], companyId: 'default' }; } });
  const bytes = JSON.stringify(current), result = await application.preview(input());
  expect(reads).toBe(1); expect(JSON.stringify(current)).toBe(bytes);
  expect(result.draft.currentSeparationOfDuties).toEqual([duty]);
  expect(result.draft.members[0]).toMatchObject({ verification: 'unverified', kind: 'human' });
  const cell = result.differences[0]!;
  expect(Object.isFrozen(cell)).toBe(true); expect(Object.isFrozen(cell.actions)).toBe(true);
  expect(Object.isFrozen('values' in cell.actions ? cell.actions.values : cell.actions.except)).toBe(true);
});
