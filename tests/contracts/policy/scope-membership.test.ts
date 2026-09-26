import { expect, it } from 'vitest';
import { resolvePolicyScopeMembership, type ScopeRegistry } from '#engine/index.js';
const actor = { issuer: 'host', subject: '1000' };
const grant = (id: string, scopes: 'all' | string[]) => ({ id, effect: 'allow', actions: ['inspect'], scopes, principals: [actor], resource: { kind: 'scope', ids: 'all' } });
const policy = (...grants: unknown[]) => ({ schemaVersion: 1, revision: 'p', restrictions: [], grants });
function registry(initial: Record<string, string> = {}, ledger = true) {
  const pins = new Map(Object.entries(initial)); const reads: string[][] = []; const writes: string[][] = [];
  const reader: ScopeRegistry = {
    async pinnedCompanies(scopeIds) { reads.push([...scopeIds]); return new Map([...pins].filter(([scope]) => scopeIds.includes(scope))); },
    async pinDeclared(scopeIds, companyId) {
      writes.push([...scopeIds]); if (!ledger) return null;
      for (const scope of scopeIds) if (!pins.has(scope)) pins.set(scope, companyId);
      return new Map([...pins].filter(([scope]) => scopeIds.includes(scope)));
    },
  };
  return { reader, reads, writes, pins };
}

it('answers POLICY_DENIED before reading the registry when no trusted grant covers the scope', async () => {
  const r = registry();
  await expect(resolvePolicyScopeMembership(policy(), actor, ['s'], 'default', r.reader)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(resolvePolicyScopeMembership(policy(grant('g', ['other'])), actor, ['s'], 'default', r.reader)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(r.reads).toEqual([]); expect(r.writes).toEqual([]);
});

it('refuses a fabricated scope reached only through `all` with SCOPE_UNKNOWN; a durable pin or an explicit declaration registers it', async () => {
  await expect(resolvePolicyScopeMembership(policy(grant('all', 'all')), actor, ['fabricated'], 'default', registry().reader))
    .rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
  expect(await resolvePolicyScopeMembership(policy(grant('all', 'all')), actor, ['own'], 'default', registry({ own: 'default' }).reader)).toEqual(['own']);
  const fresh = registry();
  expect(await resolvePolicyScopeMembership(policy(grant('named', ['s']), grant('all', 'all')), actor, ['s'], 'default', fresh.reader)).toEqual(['s']);
  // The declared scope was pinned durably at this first admission; `all` wrote nothing for the fabricated one above.
  expect(fresh.writes).toEqual([['s']]); expect(fresh.pins).toEqual(new Map([['s', 'default']]));
  // Pinned once, it is never re-homed: the same declaration under another configured company is refused.
  await expect(resolvePolicyScopeMembership(policy(grant('named', ['s'])), actor, ['s'], 'acme', fresh.reader)).rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
  expect(fresh.pins).toEqual(new Map([['s', 'default']])); expect(fresh.writes).toEqual([['s']]);
  // Read access never writes: an unpinned declared scope (no records yet) resolves to the request's company for that request only.
  const read = registry();
  expect(await resolvePolicyScopeMembership(policy(grant('named', ['s'])), actor, ['s'], 'default', read.reader, 'read')).toEqual(['s']);
  expect(read.writes).toEqual([]); expect(read.pins).toEqual(new Map());
  // No ledger to pin in (writers need one, so nothing can be admitted): the declaration resolves for this request without a pin.
  const absent = registry({}, false);
  expect(await resolvePolicyScopeMembership(policy(grant('named', ['s'])), actor, ['s'], 'default', absent.reader)).toEqual(['s']);
  expect(absent.writes).toEqual([['s']]); expect(absent.pins).toEqual(new Map());
});

it('refuses a scope pinned to another company, even when the trusted policy names it: the grant has no effect there', async () => {
  const pinned = registry({ s: 'acme' }).reader;
  await expect(resolvePolicyScopeMembership(policy(grant('named', ['s'])), actor, ['s'], 'default', pinned)).rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
  await expect(resolvePolicyScopeMembership(policy(grant('all', 'all')), actor, ['s'], 'default', pinned)).rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
  expect(await resolvePolicyScopeMembership(policy(grant('named', ['s'])), actor, ['s'], 'acme', pinned)).toEqual(['s']);
  await expect(resolvePolicyScopeMembership(policy(grant('named', ['s'])), actor, ['s'], 'Not Valid', pinned)).rejects.toThrow();
});
