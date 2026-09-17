import { expect, it } from 'vitest';
import { evaluatePolicy, policyScopeMembership } from '#domain/index.js';
const actor = { issuer: 'host', subject: '1000' };
const allow = { id: 'read', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [actor], resource: { kind: 'scope', ids: ['s'] } };
const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [allow] };
it('derives candidate membership from trusted principal and scope grants only', () => {
  expect(policyScopeMembership(policy, actor, ['s', 'other', 's'])).toEqual(['s']);
  expect(policyScopeMembership(policy, { ...actor, subject: '1001' }, ['s'])).toEqual([]);
  expect(policyScopeMembership({ ...policy, grants: [{ ...allow, effect: 'deny' }] }, actor, ['s'])).toEqual([]);
  expect(policyScopeMembership({ ...policy, grants: [{ ...allow, principals: 'all', scopes: 'all' }] }, actor, ['other'])).toEqual(['other']);
});
it('does not turn membership into permission or bypass action/resource denies', () => {
  const denied = { ...policy, grants: [allow, { ...allow, id: 'deny', effect: 'deny' }] };
  const scopeIds = policyScopeMembership(denied, actor, ['s']);
  const principal = { ...actor, id: 'user', assurance: 'os-user', scopeIds };
  expect(scopeIds).toEqual(['s']);
  expect(evaluatePolicy(denied, { principal, scopeId: 's', action: 'inspect', resource: { kind: 'scope', id: 's' } }).decision).toBe('deny');
  expect(evaluatePolicy(policy, { principal, scopeId: 's', action: 'execute', resource: { kind: 'scope', id: 's' } }).decision).toBe('deny');
});
