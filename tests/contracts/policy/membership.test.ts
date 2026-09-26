import { expect, it } from 'vitest';
import { evaluatePolicy, policyScopeGrants, policyScopeMembership } from '#domain/index.js';
const actor = { issuer: 'host', subject: '1000' };
const allow = { id: 'read', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [actor], resource: { kind: 'scope', ids: ['s'] } };
const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [allow] };
const registered = new Set(['s', 'other']);
it('derives candidate membership from trusted principal and scope grants only', () => {
  expect(policyScopeMembership(policy, actor, ['s', 'other', 's'], registered)).toEqual(['s']);
  expect(policyScopeMembership(policy, { ...actor, subject: '1001' }, ['s'], registered)).toEqual([]);
  expect(policyScopeMembership({ ...policy, grants: [{ ...allow, effect: 'deny' }] }, actor, ['s'], registered)).toEqual([]);
  expect(policyScopeMembership({ ...policy, grants: [{ ...allow, principals: 'all', scopes: 'all' }] }, actor, ['other'], registered)).toEqual(['other']);
  // The grant precondition alone still sees an `all` grant cover anything; it is not membership.
  expect(policyScopeGrants({ ...policy, grants: [{ ...allow, principals: 'all', scopes: 'all' }] }, actor, ['fabricated'])).toEqual(['fabricated']);
});
it('does not turn membership into permission or bypass action/resource denies', () => {
  const denied = { ...policy, grants: [allow, { ...allow, id: 'deny', effect: 'deny' }] };
  const scopeIds = policyScopeMembership(denied, actor, ['s'], registered);
  const principal = { ...actor, id: 'user', assurance: 'os-user', scopeIds };
  expect(scopeIds).toEqual(['s']);
  expect(evaluatePolicy(denied, { principal, scopeId: 's', action: 'inspect', resource: { kind: 'scope', id: 's' } }).decision).toBe('deny');
  expect(evaluatePolicy(policy, { principal, scopeId: 's', action: 'execute', resource: { kind: 'scope', id: 's' } }).decision).toBe('deny');
});
it('lets `scopes: all` reach registered scopes only; a grant never reaches an unregistered scope', () => {
  const all = { ...policy, grants: [{ ...allow, principals: 'all', scopes: 'all' }] };
  expect(policyScopeMembership(all, actor, ['fabricated', 's'], new Set(['s']))).toEqual(['s']);
  expect(policyScopeMembership(all, actor, ['fabricated'], new Set())).toEqual([]);
  expect(policyScopeMembership(policy, actor, ['s'], new Set())).toEqual([]);
});
