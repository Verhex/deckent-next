import { expect, it } from 'vitest';
import { assertPolicyAdministrationPreserved, usablePolicyAdmins, resolvePolicyBindings } from '#domain/index.js';
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
