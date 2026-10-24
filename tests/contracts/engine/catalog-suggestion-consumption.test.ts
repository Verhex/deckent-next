import { afterEach, describe, expect, it } from 'vitest';
import { AgentCatalogApplication, AgentStandingApplication, type AgentCatalogStore } from '#engine/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import { agentDefine, agentTasks, aggregator, catalogEvolutionFixture, countRows, enrol, person, plainTasks, removeRoots, seedMetrics } from '../support/catalog-evolution-fixture.js';

// REVISE 2742 R1 (S8-DESIGN §8, owner Q-S13): an open suggestion whose producer key was revoked is superseded and unconsumable on every path — define
// from a file or a draft, a standing card, a dismissal — checked by the application and again inside the store's write transaction, so a revoke landing
// between the check and the commit refuses too. Committed rows and promotions stay; a person's define without a suggestion is unaffected.
const roots: string[] = [];
afterEach(() => removeRoots(roots));
type Fixture = Awaited<ReturnType<typeof catalogEvolutionFixture>>;
const TABLES = ['agent_definitions', 'skill_definitions', 'agent_catalog_receipts', 'agent_standing_receipts', 'agent_standings', 'agent_standing_revisions', 'catalog_suggestion_states', 'audit_events'];
const rows = (f: Fixture) => TABLES.map(table => countRows(f.path, table));
const proposeAgent = { revision: 'site-n', rules: [{ id: 'propose-agent', version: 2, kind: 'propose-agent', status: 'provisional', params: { minTasks: 3 } }] };
const change = (action: 'promote' | 'demote', commandId: string, expectedStandingRevision: number, suggestionId: string | null) =>
  ({ schemaVersion: 1, scopeId: 'scope', commandId, action, agentId: 'auditor', revision: 1, workClass: 'feature', expectedStandingRevision, suggestionId });
async function revokeAggregator(f: Fixture, commandId = 'revoke') {
  const key = (await f.signers.list({ schemaVersion: 1, scopeId: 'scope' })).items.find(row => row.boundPrincipal?.subject === aggregator.subject)!;
  await f.signers.revoke({ schemaVersion: 1, scopeId: 'scope', commandId, keyId: key.keyId });
}
async function suggestionOf(f: Fixture, kind: string) {
  return (await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 10 })).items.find(row => row.kind === kind)!;
}
/** The raw stored state is untouched: still `open` at revision 1, one history row; the reader's view says `superseded`. */
async function expectUnconsumed(f: Fixture, suggestionId: string) {
  const shown = await f.standing(person).inspectSuggestion({ schemaVersion: 1, scopeId: 'scope', suggestionId });
  expect(shown).toMatchObject({ status: 'ok', item: { state: 'superseded', signerRevoked: true, stateRevision: 1 }, history: [{ state: 'open', revision: 1 }] });
}
/** A person's application whose write store revokes the aggregator key just before it commits (the check already passed). */
function racing(f: Fixture, principal: VerifiedPrincipal = person) {
  const deps = f.deps(principal);
  return { ...deps, openStore: async (access: 'read' | 'write'): Promise<AgentCatalogStore> => {
    const store = await deps.openStore(access);
    if (access !== 'write') return store;
    const commit = store.commit.bind(store), evolution = store.commitEvolution.bind(store);
    return Object.assign(store, { commit: async (...args: Parameters<typeof commit>) => { await revokeAggregator(f, 'race-revoke'); return commit(...args); },
      commitEvolution: async (...args: Parameters<typeof evolution>) => { await revokeAggregator(f, 'race-revoke'); return evolution(...args); } });
  } };
}
async function withProposeAgent() {
  const f = await catalogEvolutionFixture(roots, { overlay: proposeAgent });
  await f.signers.enrol(enrol(aggregator, 'e-aggregator'));
  seedMetrics(f.path, ...plainTasks(4, 4).map(row => ({ ...row, workClass: 'docs' })));
  await f.evolution().runPass('scope', 'on');
  return { f, suggestion: await suggestionOf(f, 'propose-agent') };
}
async function withPromote() {
  const f = await catalogEvolutionFixture(roots);
  await f.catalog().defineAgent(agentDefine('auditor', 'a1'));
  await f.signers.enrol(enrol(aggregator, 'e-aggregator'));
  seedMetrics(f.path, ...agentTasks('auditor', 20, 20), ...plainTasks(10, 5));
  await f.evolution().runPass('scope', 'on');
  return { f, suggestion: await suggestionOf(f, 'promote-agent') };
}

describe('a revoked producer key: define from a file is refused (REVISE 2742 R1)', () => {
  it('revise-agent: the next revision from a file naming the suggestion is refused; nothing is written; the promotion stays; a define without it works', async () => {
    const f = await catalogEvolutionFixture(roots);
    await f.catalog().defineAgent(agentDefine('auditor', 'a1'));
    await f.standing(person).change(change('promote', 'p1', 1, null));
    await f.signers.enrol(enrol(aggregator, 'e-aggregator'));
    seedMetrics(f.path, ...agentTasks('auditor', 10, 9).map(row => ({ ...row, durationMs: 3000 })), ...plainTasks(10, 5));
    await f.evolution().runPass('scope', 'on');
    const suggestion = await suggestionOf(f, 'revise-agent');
    expect(suggestion).toMatchObject({ state: 'open', key: { kind: 'agent', agentId: 'auditor', revision: 1 } });
    await revokeAggregator(f);
    const before = rows(f);
    await expect(f.catalog().defineAgent({ ...agentDefine('auditor', 'a2', 1), fromSuggestion: suggestion.suggestionId })).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
    expect(rows(f)).toEqual(before);
    await expectUnconsumed(f, suggestion.suggestionId);
    // Owner Q-S13: the committed revision and its promotion stay; a person's define without the suggestion is unaffected.
    expect(await f.catalog().inspectAgent({ schemaVersion: 1, scopeId: 'scope', agentId: 'auditor' })).toMatchObject({ item: { revision: 1 }, standings: [{ standing: 'active' }] });
    const made = await f.catalog().defineAgent(agentDefine('auditor', 'a3', 1));
    expect(made.item).toMatchObject({ revision: 2 });
    expect(made.item.provenance.origin).toBeUndefined();
  });
  it('propose-agent and propose-skill: a define naming a revoked key\'s suggestion is refused; an active key\'s is decided', async () => {
    const { f, suggestion } = await withProposeAgent();
    await revokeAggregator(f);
    const before = rows(f);
    await expect(f.catalog().defineAgent({ ...agentDefine('writer', 'a1', null, ['docs']), fromSuggestion: suggestion.suggestionId })).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
    expect(rows(f)).toEqual(before);
    await expectUnconsumed(f, suggestion.suggestionId);
    expect((await f.catalog().defineAgent(agentDefine('writer', 'a2', null, ['docs']))).item).toMatchObject({ revision: 1 });

    const lesson = (id: string) => ({ entryId: id, revision: 1, contentDigest: id.repeat(32).slice(0, 64), audience: null });
    const s = await catalogEvolutionFixture(roots, { lessons: [lesson('a1'), lesson('b2'), lesson('c3')] });
    await s.signers.enrol(enrol(aggregator, 'e-aggregator'));
    seedMetrics(s.path, ...plainTasks(1, 1));
    await s.evolution().runPass('scope', 'on');
    const skill = await suggestionOf(s, 'propose-skill');
    await revokeAggregator(s);
    const skillBefore = rows(s);
    await expect(s.catalog().defineSkill({ schemaVersion: 1, scopeId: 'scope', commandId: 'k1', skillId: 'lessons', expectedRevision: null, content: { name: 'Dersler', text: 'Metin.' },
      fromSuggestion: skill.suggestionId })).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
    expect(rows(s)).toEqual(skillBefore);
    await expectUnconsumed(s, skill.suggestionId);

    // A supersede consumes nothing: after a key rotation the aggregator's next window still supersedes the revoked key's open suggestion.
    const rotated = await withPromote();
    await revokeAggregator(rotated.f);
    await rotated.f.signers.enrol(enrol(aggregator, 'e-aggregator-2'));
    seedMetrics(rotated.f.path, ...agentTasks('auditor', 20, 20, 'more'));
    expect(await rotated.f.evolution().runPass('scope', 'on')).toMatchObject({ suggestions: { written: 1, superseded: 1 } });
    expect(await rotated.f.standing(person).inspectSuggestion({ schemaVersion: 1, scopeId: 'scope', suggestionId: rotated.suggestion.suggestionId }))
      .toMatchObject({ item: { state: 'superseded', signerRevoked: false }, history: [{ state: 'open' }, { state: 'superseded' }] });

    const live = await withProposeAgent();
    const made = await live.f.catalog().defineAgent({ ...agentDefine('writer', 'a1', null, ['docs']), fromSuggestion: live.suggestion.suggestionId });
    expect(made.item.provenance.origin).toMatchObject({ suggestionId: live.suggestion.suggestionId });
  });
});

describe('a revoke between the check and the commit refuses inside the write transaction (REVISE 2742 R1)', () => {
  it('define from a suggestion', async () => {
    const { f, suggestion } = await withProposeAgent();
    const catalog = new AgentCatalogApplication(racing(f)), before = rows(f);
    await expect(catalog.defineAgent({ ...agentDefine('writer', 'a1', null, ['docs']), fromSuggestion: suggestion.suggestionId })).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
    // The revoke itself wrote its own audit event; nothing of the define did.
    expect(rows(f)).toEqual(before.map((n, i) => TABLES[i] === 'audit_events' ? n + 1 : n));
    await expectUnconsumed(f, suggestion.suggestionId);
  });
  it('a standing card deciding a suggestion', async () => {
    const { f, suggestion } = await withPromote();
    const standing = new AgentStandingApplication(racing(f)), before = rows(f);
    await expect(standing.change(change('promote', 'p1', 1, suggestion.suggestionId))).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
    expect(rows(f)).toEqual(before.map((n, i) => TABLES[i] === 'audit_events' ? n + 1 : n));
    await expectUnconsumed(f, suggestion.suggestionId);
    expect(await f.catalog().inspectAgent({ schemaVersion: 1, scopeId: 'scope', agentId: 'auditor' })).toMatchObject({ standings: [{ standing: 'candidate', standingRevision: 1 }] });
  });
  it('a dismissal', async () => {
    const { f, suggestion } = await withPromote();
    const standing = new AgentStandingApplication(racing(f)), before = rows(f);
    await expect(standing.dismiss({ schemaVersion: 1, scopeId: 'scope', commandId: 'd1', suggestionId: suggestion.suggestionId, expectedStateRevision: 1 })).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
    expect(rows(f)).toEqual(before.map((n, i) => TABLES[i] === 'audit_events' ? n + 1 : n));
    await expectUnconsumed(f, suggestion.suggestionId);
  });
});
