import { expect, it } from 'vitest';
import { assertPolicyAdministrationPreserved, usablePolicyAdmins, resolvePolicyBindings, evaluatePolicy } from '#domain/index.js';
import { PolicyAdministrationInspection, validateAuthorityWrite } from '#engine/index.js';
const actor = { issuer: 'host', subject: 'admin' }, other = { issuer: 'host', subject: 'other' };
const principal = { ...actor, id: 'os:admin', assurance: 'os-user' as const, scopeIds: ['s'] };
const grants = (person = actor) => [
  { id: `manage-${person.subject}`, principals: [person], scopes: 'all', effect: 'allow', actions: ['execute'], resource: { kind: 'operation', ids: ['policy.administer'] } },
  { id: `decide-${person.subject}`, principals: [person], scopes: 'all', effect: 'allow', actions: ['inspect', 'decide'], resource: { kind: 'approval', ids: 'all' } },
];
const policy = { schemaVersion: 2, revision: 'p', roles: [], grants: grants(), restrictions: [], separationOfDuties: [] };
const bindings = { schemaVersion: 3, revision: 'b', bindings: [], modes: [] };
const resolved = (body: unknown) => resolvePolicyBindings(body, bindings);

it('protects effective administration against grants, deny/restriction, SoD and unavailable assurance in v1/v2, including wildcard scopes', () => {
  const changes = [
    { ...policy, grants: [] },
    { ...policy, grants: [...grants(), { ...grants()[1], id: 'deny', effect: 'deny', scopes: ['s'] }] },
    { ...policy, restrictions: [{ id: 'restriction', principals: [actor], scopes: ['s'], actions: ['decide'], resource: { kind: 'approval', ids: 'all' } }] },
    { ...policy, separationOfDuties: [{ id: 'four-eyes', rule: 'requester-cannot-approve', scopes: ['s'] }] },
    { ...policy, approvalAssurance: [{ id: 'unavailable', subject: 'operation', authority: true, scopes: ['s'], minimum: 'turn-bound' }] },
    { ...policy, grants: grants().map(grant => ({ ...grant, scopes: ['s'] })) },
  ];
  for (const change of changes) {
    expect(() => assertPolicyAdministrationPreserved(resolved(policy), resolved(change))).toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
  }
  const legacy = { schemaVersion: 1, revision: 'v1', grants: grants(), restrictions: [] };
  expect(() => assertPolicyAdministrationPreserved(legacy, { ...legacy, grants: [] })).toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
  expect(() => assertPolicyAdministrationPreserved(resolved({ ...policy, grants: [...grants(), ...grants(other)] }), resolved({ ...policy, grants: grants(other) }))).not.toThrow();
  expect(usablePolicyAdmins(resolved({ ...policy, grants: grants({ issuer: 'host/mcp', subject: 'admin' }) }), 's')).toEqual([]);
  expect(usablePolicyAdmins(resolved({ ...policy, grants: grants().map(grant => ({ ...grant, principals: 'all' })) }), 's')).toEqual([]);
});

it('the single writer checkpoint rejects an intermediate lockout and preserves admin authority across permission modes', () => {
  const role = { id: 'admin', permissions: grants().map(({ id, effect, actions, resource }) => ({ id, effect, actions, resource })) };
  const before = { ...policy, grants: [], roles: [role] };
  const old = { ...bindings, bindings: [{ id: 'root', roles: ['admin'], principals: [actor], scopes: 'all' }] };
  const next = { ...policy, revision: 'next' }, empty = { ...bindings, revision: 'next' };
  expect(() => validateAuthorityWrite({ policy: before, bindings: old }, { policy: next, bindings: empty, order: 'bindings-first' })).toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
  for (const mode of ['standart', 'full-auto', 'full-access']) {
    expect(() => validateAuthorityWrite({ policy, bindings }, { policy: null,
      bindings: { ...bindings, modes: [{ id: 'mode', principal: actor, scopes: ['s'], mode }] }, order: 'policy-first' })).not.toThrow();
  }
});

it('status reports policy capability and revisions truthfully, refuses other scopes, and recognizes a headless observed policy', async () => {
  let document = resolved(policy);
  const inspection = new PolicyAdministrationInspection({ load: async () => document });
  expect(await inspection.inspect(principal, { schemaVersion: 1, scopeId: 's' })).toMatchObject({ usableAdminCount: 1, admins: [actor], revision: 'p+b',
    template: { kind: 'hand-built', version: null }, bootstrapRequired: false, recoveryRequired: false, identityReadiness: 'not-verified' });
  await expect(inspection.inspect(principal, { schemaVersion: 1, scopeId: 'other' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  document = resolved({ ...policy, grants: [{ id: 'inspect', effect: 'allow', principals: [actor], scopes: ['s'], actions: ['inspect'], resource: { kind: 'scope', ids: ['s'] } }] });
  expect(await inspection.inspect(principal, { schemaVersion: 1, scopeId: 's' })).toMatchObject({ usableAdminCount: 0, bootstrapRequired: true });
});

it.each(['deny', 'restriction', 'require-approval'])('fresh approval witnesses ignore only explicit old %s selectors, including role-derived rules and collisions', effect => {
  const narrow = { id: 'old', principals: [actor], scopes: 'all', actions: ['decide'], resource: { kind: 'approval', ids: ['0', '1', '2', '3', '6', 'old-X'] } };
  for (const origin of ['grant', 'role']) {
    const { id, actions, resource } = narrow;
    const body = { ...policy, grants: [...grants(), ...(effect !== 'restriction' && origin === 'grant' ? [{ ...narrow, effect }] : [])],
      restrictions: effect === 'restriction' ? [narrow] : [],
      roles: effect !== 'restriction' && origin === 'role' ? [{ id: 'limited', permissions: [{ id, actions, resource, effect }] }] : [] };
    const bound = effect !== 'restriction' && origin === 'role' ? { ...bindings, bindings: [{ id: 'narrow', roles: ['limited'], principals: [actor], scopes: 'all' }] } : bindings;
    const document = resolvePolicyBindings(body, bound);
    expect(evaluatePolicy(document, { principal, scopeId: 's', action: 'decide', resource: { kind: 'approval', id: 'new-Y' } }).decision).toBe('allow');
    expect(usablePolicyAdmins(document, 's')).toEqual([actor]);
    expect(() => assertPolicyAdministrationPreserved(document, resolvePolicyBindings({ ...body, grants: body.grants.filter(rule => rule.id !== 'manage-admin') }, bound)))
      .toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
  }
});

it('zero before admins never exempts authority reductions; monotonic headless repairs and unrelated writes remain available', () => {
  const headless = { ...policy, grants: [grants()[0]!] };
  expect(usablePolicyAdmins(resolved(headless), 's')).toEqual([]);
  expect(() => assertPolicyAdministrationPreserved(resolved(headless), resolved({ ...headless, grants: [] })))
    .toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
  expect(() => assertPolicyAdministrationPreserved(resolved(headless), resolved(policy))).not.toThrow();
  const blocked = { ...policy, separationOfDuties: [{ id: 'four-eyes', rule: 'requester-cannot-approve', scopes: 'all' }] };
  expect(usablePolicyAdmins(resolved(blocked), 's')).toEqual([]);
  expect(() => assertPolicyAdministrationPreserved(resolved(blocked), resolved({ ...blocked, grants: [] })))
    .toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
  expect(() => assertPolicyAdministrationPreserved(resolved(blocked), resolved({ ...blocked, grants: [...grants(), ...grants(other)] }))).not.toThrow();
  expect(() => assertPolicyAdministrationPreserved(resolved(blocked), resolved(policy))).not.toThrow();
  expect(() => assertPolicyAdministrationPreserved(resolved(headless), resolved({ ...headless, grants: [...headless.grants,
    { id: 'unrelated', principals: [actor], scopes: 'all', actions: ['inspect'], effect: 'allow', resource: { kind: 'scope', ids: 'all' } }] }))).not.toThrow();
  expect(() => assertPolicyAdministrationPreserved({}, resolved(policy))).toThrow();
});

it.each(['deny', 'restriction', 'require-approval'])('zero before admins cannot gain a new %s blocker or narrow existing operation authority', effect => {
  const headless = { ...policy, grants: [grants()[0]!] };
  const blocker = { id: 'blocker', principals: [actor], scopes: ['s'], actions: ['decide'], resource: { kind: 'approval', ids: ['old-X'] } };
  const after = effect === 'restriction' ? { ...headless, restrictions: [blocker] } : { ...headless, grants: [...headless.grants, { ...blocker, effect }] };
  expect(() => assertPolicyAdministrationPreserved(resolved(headless), resolved(after))).toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
  expect(() => assertPolicyAdministrationPreserved(resolved(headless), resolved({ ...headless, grants: headless.grants.map(grant => ({ ...grant, scopes: ['s'] })) })))
    .toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
});

it('zero before admins also protects role bindings, assurance constraints and both crash-visible write orders', () => {
  const role = { id: 'partial', permissions: [{ id: 'manage', effect: 'allow', actions: ['execute'], resource: { kind: 'operation', ids: ['policy.administer'] } }] };
  const body = { ...policy, grants: [], roles: [role] }, bound = { ...bindings, bindings: [{ id: 'partial', principals: [actor], roles: ['partial'], scopes: 'all' }] };
  expect(() => assertPolicyAdministrationPreserved(resolvePolicyBindings(body, bound), resolved(body))).toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
  expect(() => assertPolicyAdministrationPreserved(resolved(body), resolvePolicyBindings(body, bound))).not.toThrow();
  const assurance = { ...policy, approvalAssurance: [{ id: 'strong', subject: 'operation', scopes: 'all', minimum: 'turn-bound' }] };
  expect(() => assertPolicyAdministrationPreserved(resolved(assurance), resolved({ ...assurance, grants: [] }))).toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
  expect(() => assertPolicyAdministrationPreserved(resolved(body), resolved({ ...body, approvalAssurance: assurance.approvalAssurance })))
    .toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
  const direct = { ...policy, roles: [role], grants: [grants()[0]!] };
  expect(() => assertPolicyAdministrationPreserved(resolvePolicyBindings(body, bound), resolved(direct))).not.toThrow();
  expect(() => validateAuthorityWrite({ policy: body, bindings: bound }, { policy: direct, bindings, order: 'bindings-first' }))
    .toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
  expect(() => validateAuthorityWrite({ policy: direct, bindings }, { policy: body, bindings: bound, order: 'policy-first' }))
    .toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
});

it('zero before admins cannot lose existing approval capability under a new require-approval; required operation requests remain usable', () => {
  const approvalsOnly = { ...policy, grants: [grants()[1]!] };
  const required = { ...grants()[1], id: 'ask', effect: 'require-approval', actions: ['decide'] };
  expect(() => assertPolicyAdministrationPreserved(resolved(approvalsOnly), resolved({ ...approvalsOnly, grants: [...approvalsOnly.grants, required] })))
    .toThrowError(expect.objectContaining({ code: 'POLICY_LAST_ADMIN' }));
  expect(usablePolicyAdmins(resolved({ ...policy, grants: grants().map(grant => grant.resource.kind === 'operation' ? { ...grant, effect: 'require-approval' } : grant) }), 's'))
    .toEqual([actor]);
});
