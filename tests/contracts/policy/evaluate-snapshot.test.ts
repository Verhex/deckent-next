import { afterEach, expect, it, vi } from 'vitest';
import { evaluatePolicy, policySchema } from '#domain/index.js';

// Monitor 2026-10-17: one snapshot evaluated the same loaded policy document for hundreds of attempts and re-validated it every time.
const owner = { issuer: 'host', subject: '1000' };
const principal = { id: '1000@host', ...owner, assurance: 'os-user' as const, scopeIds: ['proj'] };
const request = (id: string) => ({ principal, scopeId: 'proj', action: 'read-output', resource: { kind: 'attempt', id } });
const raw = () => ({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [{ id: 'read', effect: 'allow', scopes: ['proj'], actions: ['read-output'],
  resource: { kind: 'attempt', ids: 'all' }, principals: [owner] }] });
afterEach(() => { vi.restoreAllMocks(); });
it('validates a parsed (deep-frozen) policy document once per object and keeps every decision identical', () => {
  const document = policySchema.parse(raw()), spy = vi.spyOn(policySchema, 'safeParse');
  const decisions = Array.from({ length: 50 }, (_, index) => evaluatePolicy(document, request(`a${index}`)));
  expect(spy).toHaveBeenCalledTimes(1);
  expect(new Set(decisions.map(value => JSON.stringify(value)))).toEqual(new Set([JSON.stringify({ decision: 'allow', revision: 'p1', reason: 'GRANTED', ruleId: 'read' })]));
});
it('re-validates a mutable document on every call, so a later change is decided as written', () => {
  const document = raw(), spy = vi.spyOn(policySchema, 'safeParse');
  expect(evaluatePolicy(document, request('a'))).toMatchObject({ decision: 'allow' });
  document.grants[0]!.effect = 'deny';
  expect(evaluatePolicy(document, request('a'))).toMatchObject({ decision: 'deny', reason: 'DENIED' });
  document.grants[0]!.effect = 'unknown-effect';
  expect(() => evaluatePolicy(document, request('a'))).toThrow();
  expect(spy).toHaveBeenCalledTimes(3);
});
