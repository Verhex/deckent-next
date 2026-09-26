import { expect, it } from 'vitest';
import { resolvePolicyScopeMembership, type ScopeRegistryReader } from '#engine/index.js';
const actor = { issuer: 'host', subject: '1000' };
const grant = (id: string, scopes: 'all' | string[]) => ({ id, effect: 'allow', actions: ['inspect'], scopes, principals: [actor], resource: { kind: 'scope', ids: 'all' } });
const policy = (...grants: unknown[]) => ({ schemaVersion: 1, revision: 'p', restrictions: [], grants });
function registry(pins: Record<string, string> = {}) {
  const reads: string[][] = [];
  const reader: ScopeRegistryReader = { async pinnedCompanies(scopeIds) { reads.push([...scopeIds]); return new Map(Object.entries(pins).filter(([scope]) => scopeIds.includes(scope))); } };
  return { reader, reads };
}

it('answers POLICY_DENIED before reading the registry when no trusted grant covers the scope', async () => {
  const r = registry();
  await expect(resolvePolicyScopeMembership(policy(), actor, ['s'], 'default', r.reader)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(resolvePolicyScopeMembership(policy(grant('g', ['other'])), actor, ['s'], 'default', r.reader)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(r.reads).toEqual([]);
});

it('refuses a fabricated scope reached only through `all` with SCOPE_UNKNOWN; a durable pin or an explicit declaration registers it', async () => {
  await expect(resolvePolicyScopeMembership(policy(grant('all', 'all')), actor, ['fabricated'], 'default', registry().reader))
    .rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
  expect(await resolvePolicyScopeMembership(policy(grant('all', 'all')), actor, ['own'], 'default', registry({ own: 'default' }).reader)).toEqual(['own']);
  expect(await resolvePolicyScopeMembership(policy(grant('named', ['s']), grant('all', 'all')), actor, ['s'], 'default', registry().reader)).toEqual(['s']);
});

it('refuses a scope pinned to another company, even when the trusted policy names it: the grant has no effect there', async () => {
  const pinned = registry({ s: 'acme' }).reader;
  await expect(resolvePolicyScopeMembership(policy(grant('named', ['s'])), actor, ['s'], 'default', pinned)).rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
  await expect(resolvePolicyScopeMembership(policy(grant('all', 'all')), actor, ['s'], 'default', pinned)).rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
  expect(await resolvePolicyScopeMembership(policy(grant('named', ['s'])), actor, ['s'], 'acme', pinned)).toEqual(['s']);
  await expect(resolvePolicyScopeMembership(policy(grant('named', ['s'])), actor, ['s'], 'Not Valid', pinned)).rejects.toThrow();
});
