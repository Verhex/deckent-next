import { describe, expect, it } from 'vitest';
import { companyIdSchema, policyDeclaredScopes, policyScopeGrants, policyScopeMembership } from '#domain/index.js';

const actor = { issuer: 'host', subject: '1000' };
const grant = (over: Record<string, unknown> = {}) => ({ id: 'g', effect: 'allow', actions: ['inspect'], scopes: ['a'], principals: [actor], resource: { kind: 'scope', ids: 'all' }, ...over });
const policy = (...grants: unknown[]) => ({ schemaVersion: 1, revision: 'p', restrictions: [], grants });

describe('policy scope edges', () => {
  it('companyIdSchema accepts the 63-char boundary and refuses 64, empty, leading dash and uppercase', () => {
    expect(companyIdSchema.safeParse('a'.repeat(63)).success).toBe(true);
    expect(companyIdSchema.safeParse('0-x').success).toBe(true);
    for (const bad of ['a'.repeat(64), '', '-a', 'Acme', 'a_b', 'a b', 'a\n']) expect(companyIdSchema.safeParse(bad).success).toBe(false);
  });
  it('companyIdSchema reports an invalid_string/regex issue and rejects non-strings', () => {
    const result = companyIdSchema.safeParse('Bad');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual([]);
    expect(companyIdSchema.safeParse(7).success).toBe(false);
  });
  it('policyDeclaredScopes dedupes, ignores deny grants and `all`, and returns a frozen list', () => {
    const declared = policyDeclaredScopes(policy(grant({ scopes: ['a', 'b'] }), grant({ id: 'h', scopes: ['b', 'c'] }), grant({ id: 'd', effect: 'deny', scopes: ['x'] }), grant({ id: 'e', scopes: 'all' })));
    expect(declared).toEqual(['a', 'b', 'c']);
    expect(Object.isFrozen(declared)).toBe(true);
    expect(policyDeclaredScopes(policy())).toEqual([]);
  });
  it('policyDeclaredScopes refuses a malformed policy', () => {
    expect(() => policyDeclaredScopes({ schemaVersion: 1 })).toThrow();
    expect(() => policyDeclaredScopes(null)).toThrow();
  });
  it('policyScopeGrants dedupes candidates, keeps order and is frozen; empty candidates give empty', () => {
    const result = policyScopeGrants(policy(grant({ scopes: ['a', 'b'] })), actor, ['b', 'a', 'b', 'z']);
    expect(result).toEqual(['b', 'a']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(policyScopeGrants(policy(grant()), actor, [])).toEqual([]);
  });
  it('policyScopeGrants refuses invalid candidate or actor identities instead of filtering them', () => {
    expect(() => policyScopeGrants(policy(grant()), actor, [''])).toThrow();
    expect(() => policyScopeGrants(policy(grant()), { issuer: '', subject: '1' }, ['a'])).toThrow();
    expect(() => policyScopeGrants(policy(grant()), { issuer: 'host', subject: '' }, ['a'])).toThrow();
  });
  it('principal matching is exact on both issuer and subject', () => {
    const p = policy(grant());
    expect(policyScopeGrants(p, { issuer: 'other', subject: '1000' }, ['a'])).toEqual([]);
    expect(policyScopeGrants(p, { issuer: 'host', subject: '1001' }, ['a'])).toEqual([]);
    expect(() => policyScopeGrants(p, { issuer: 'host', subject: '1000 ' }, ['a'])).toThrow();
  });
  it('membership needs the scope registered even for a named grant; an empty registry yields nothing', () => {
    const p = policy(grant({ scopes: ['a'] }));
    expect(policyScopeMembership(p, actor, ['a'], new Set(['a']))).toEqual(['a']);
    expect(policyScopeMembership(p, actor, ['a'], new Set(['b']))).toEqual([]);
    expect(policyScopeMembership(p, actor, ['a'], new Set())).toEqual([]);
  });
  it('membership is a subset of grants; a named grant never reaches a registered scope it does not name', () => {
    const p = policy(grant({ scopes: ['a'] }));
    expect(policyScopeMembership(p, actor, ['a', 'b'], new Set(['a', 'b']))).toEqual(['a']);
    const registered = new Set(['a', 'b']);
    const all = policy(grant({ scopes: 'all', principals: 'all' }));
    const members = policyScopeMembership(all, actor, ['a', 'b', 'c'], registered);
    expect(members).toEqual(['a', 'b']);
    for (const m of members) expect(policyScopeGrants(all, actor, ['a', 'b', 'c'])).toContain(m);
  });
  it('a deny grant never contributes membership even when an all-principal allow exists for another scope', () => {
    const p = policy(grant({ scopes: ['a'], principals: 'all' }), grant({ id: 'd', effect: 'deny', scopes: ['b'] }));
    expect(policyScopeMembership(p, actor, ['a', 'b'], new Set(['a', 'b']))).toEqual(['a']);
  });
});
