import { expect, it } from 'vitest';
import { evaluatePolicy } from '#domain/index.js';
import { DispatchPolicyAuthorization } from '#engine/index.js';
const principal = { id: 'user', issuer: 'installation', subject: 'uid:1000', assurance: 'os-user' as const, scopeIds: ['s'] };
const match = { id: 'grant', actions: ['execute'], scopes: ['s'], principals: [{ issuer: 'installation', subject: 'uid:1000' }], resource: { kind: 'attempt', ids: ['a'] } };
const policy = { schemaVersion: 1, revision: 'r1', grants: [{ ...match, effect: 'allow' }], restrictions: [] };
const query = { principal, scopeId: 's', action: 'execute', resource: { kind: 'attempt', id: 'a' } };
const request = { protocolVersion: 1 as const, identity: { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'l' }, workspace: '/workspace', argv: ['tool'] };
it('requires exact principal, scope, action and resource without role/persona aliases', () => {
  expect(evaluatePolicy(policy, query).decision).toBe('allow');
  for (const changed of [{ ...query, action: 'release' }, { ...query, resource: { kind: 'attempt', id: 'b' } },
    { ...query, principal: { ...principal, subject: 'senior-developer' } }, { ...query, scopeId: 'foreign' }]) {
    expect(evaluatePolicy(policy, changed).decision).toBe('deny');
  }
  expect(evaluatePolicy({ ...policy, grants: [] }, query).reason).toBe('NO_GRANT');
});
it('makes explicit deny and restrictive overlays stronger than grants regardless of rule order', () => {
  const deny = { ...match, id: 'deny', effect: 'deny' };
  for (const grants of [[policy.grants[0], deny], [deny, policy.grants[0]]]) expect(evaluatePolicy({ ...policy, grants }, query).reason).toBe('DENIED');
  expect(evaluatePolicy({ ...policy, restrictions: [{ ...match, id: 'restriction' }] }, query).reason).toBe('DENIED');
  expect(() => evaluatePolicy({ ...policy, restrictions: [{ ...match, effect: 'allow' }] }, query)).toThrow('POLICY_INVALID');
  expect(() => evaluatePolicy({ ...policy, grants: [...policy.grants, ...policy.grants] }, query)).toThrow('POLICY_INVALID');
});
it('reloads trusted policy on every admission and sanitizes invalid or unavailable policy', async () => {
  let current: unknown = policy; const gate = new DispatchPolicyAuthorization({ async load() { return current; } });
  await expect(gate.authorize('execute', request, principal)).resolves.toBeUndefined();
  current = { ...policy, revision: 'revoked', grants: [] };
  await expect(gate.authorize('execute', request, principal)).rejects.toThrow('POLICY_DENIED');
  current = { secret: 'not-an-authority' }; await expect(gate.authorize('execute', request, principal)).rejects.toThrow('POLICY_UNAVAILABLE');
  const unavailable = new DispatchPolicyAuthorization({ async load() { throw new Error('private-credential'); } });
  await expect(unavailable.authorize('execute', request, principal)).rejects.toThrow('POLICY_UNAVAILABLE');
});
