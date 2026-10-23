import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { transitionAgentStanding } from '#domain/index.js';
import { NOW } from '../support/catalog-metrics.js';
import { agentDefine, agentTasks, aggregator, catalogEvolutionFixture, countRows, enrol, grant, mcp, person, plainTasks, remote, removeRoots, seedMetrics } from '../support/catalog-evolution-fixture.js';

// S8-4 (S8-DESIGN §6, §7, §8, §9, §12): a person's standing card or a signed, WorkClass-granted AI command moves one standing under compare-and-set and
// decides the open suggestion it names; nothing decides a stale, shadow or own suggestion; an AI never promotes what it wrote (another signed AI may,
// owner Q-S12); a revoked key's promotions stay until a person demotes them in one step (owner Q-S13); drafts are a person's card only.
const roots: string[] = [];
afterEach(() => removeRoots(roots));
const change = (action: 'promote' | 'demote' | 'restore' | 'retire', commandId: string, expectedStandingRevision: number, extra: Record<string, unknown> = {}) =>
  ({ schemaVersion: 1, scopeId: 'scope', commandId, action, agentId: 'auditor', revision: 1, workClass: 'feature', expectedStandingRevision, suggestionId: null, ...extra });
async function withPromoteSuggestion(options: Parameters<typeof catalogEvolutionFixture>[1] = {}) {
  const f = await catalogEvolutionFixture(roots, options);
  await f.catalog().defineAgent(agentDefine('auditor', 'a1'));
  await f.signers.enrol(enrol(aggregator, 'e-aggregator'));
  seedMetrics(f.path, ...agentTasks('auditor', 20, 20), ...plainTasks(10, 5));
  await f.evolution().runPass('scope', options.mode ?? 'on');
  const suggestion = (await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 5 })).items.find(row => row.kind === 'promote-agent')!;
  return { f, suggestion };
}
const standingOf = async (f: Awaited<ReturnType<typeof catalogEvolutionFixture>>, agentId = 'auditor') => {
  const shown = await f.catalog().inspectAgent({ schemaVersion: 1, scopeId: 'scope', agentId });
  return shown.status === 'ok' ? shown.standings[0]! : null;
};

describe('person cards', () => {
  it('a promote card decides its suggestion; a replay answers replayed; a second card on it is stale (N13); a stale standing revision is a conflict (N12)', async () => {
    const { f, suggestion } = await withPromoteSuggestion();
    const done = await f.standing(person).change(change('promote', 'p1', 1, { suggestionId: suggestion.suggestionId }));
    expect(done.standings[0]).toMatchObject({ standing: 'active', standingRevision: 2, basis: { kind: 'person-card', suggestionId: suggestion.suggestionId } });
    expect(await f.standing(person).change(change('promote', 'p1', 1, { suggestionId: suggestion.suggestionId }))).toMatchObject({ replayed: true });
    expect((await f.standing(person).inspectSuggestion({ schemaVersion: 1, scopeId: 'scope', suggestionId: suggestion.suggestionId }))).toMatchObject({ status: 'ok',
      item: { state: 'decided', decision: 'promote', decidedBy: { ai: false } }, history: [{ state: 'open' }, { state: 'decided' }] });
    await expect(f.standing(person).change(change('demote', 'p2', 2, { suggestionId: suggestion.suggestionId }))).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
    await expect(f.standing(person).change(change('demote', 'p3', 1))).rejects.toMatchObject({ code: 'AGENT_STANDING_CONFLICT' });
    await expect(f.standing(person).change(change('promote', 'p1', 1))).rejects.toMatchObject({ code: 'AGENT_CATALOG_COMMAND_CONFLICT' });
    expect((await f.standing(person).change(change('demote', 'p4', 2))).standings[0]).toMatchObject({ standing: 'candidate', standingRevision: 3 });
  });
  it('N13: an expired, dismissed or shadow suggestion is never decided; the producer never dismisses its own', async () => {
    const { f, suggestion } = await withPromoteSuggestion();
    await expect(f.standing(aggregator).dismiss({ schemaVersion: 1, scopeId: 'scope', commandId: 'd0', suggestionId: suggestion.suggestionId, expectedStateRevision: 1 }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    f.setNow(suggestion.expiresAtMs + 1);
    await expect(f.standing(person).change(change('promote', 'p1', 1, { suggestionId: suggestion.suggestionId }))).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
    f.setNow(NOW + 1000);
    await expect(f.standing(person).dismiss({ schemaVersion: 1, scopeId: 'scope', commandId: 'd1', suggestionId: suggestion.suggestionId, expectedStateRevision: 2 })).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
    expect((await f.standing(person).dismiss({ schemaVersion: 1, scopeId: 'scope', commandId: 'd2', suggestionId: suggestion.suggestionId, expectedStateRevision: 1 })).state).toMatchObject({ state: 'dismissed' });
    await expect(f.standing(person).change(change('promote', 'p2', 1, { suggestionId: suggestion.suggestionId }))).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
    expect((await standingOf(f))?.standing).toBe('candidate');
    const shadow = await withPromoteSuggestion({ mode: 'shadow' });
    await expect(shadow.f.standing(person).change(change('promote', 'p1', 1, { suggestionId: shadow.suggestion.suggestionId }))).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_SHADOW' });
  });
  it('a promotion turns the WorkClass\'s current promoted agent into a candidate in the same commit; N26: two promotions on one state — the second is refused', async () => {
    const f = await catalogEvolutionFixture(roots);
    await f.catalog().defineAgent(agentDefine('auditor', 'a1')); await f.catalog().defineAgent(agentDefine('other', 'a2'));
    await f.standing(person).change({ ...change('promote', 'p1', 1), agentId: 'other' });
    const done = await f.standing(person).change(change('promote', 'p2', 1));
    expect(done.standings.map(row => [row.agentId, row.standing])).toEqual([['auditor', 'active'], ['other', 'candidate']]);
    // A promotion computed before the first one committed (no displaced agent known): the store's one-active rule refuses it.
    const writer = await f.deps(person).openStore('write');
    try {
      const previous = (await writer.standings('scope', 'other', 1))[0]!, next = transitionAgentStanding(previous, { action: 'promote', expectedStandingRevision: previous.standingRevision,
        actor: { issuer: person.issuer, subject: person.subject, ai: false }, atMs: 1, commandId: 'race', suggestionId: null })[0]!;
      await expect(writer.commitEvolution({ scopeId: 'scope', principal: { issuer: person.issuer, subject: person.subject, ai: false }, receipt: { scopeId: 'scope', commandId: 'race', digest: 'a'.repeat(64) },
        standings: [{ previous, next, action: 'promote' }], suggestions: [], states: [], signed: [], events: [] })).rejects.toMatchObject({ code: 'AGENT_STANDING_CONFLICT' });
    } finally { writer.close(); }
    expect(countRows(f.path, 'agent_standings', "WHERE standing='active'")).toBe(1);
  });
  it('a reset card moves every promoted or narrowed current revision of one WorkClass back to candidate; stale targets are a conflict; no AI resets', async () => {
    const f = await catalogEvolutionFixture(roots);
    await f.catalog().defineAgent(agentDefine('auditor', 'a1'));
    await f.standing(person).change(change('promote', 'p1', 1));
    const target = { agentId: 'auditor', revision: 1, workClass: 'feature', expectedStandingRevision: 2 };
    await expect(f.standing(person).bulk({ schemaVersion: 1, scopeId: 'scope', commandId: 'b0', reason: { kind: 'reset', workClass: 'feature' }, targets: [{ ...target, expectedStandingRevision: 1 }] }))
      .rejects.toMatchObject({ code: 'AGENT_STANDING_CONFLICT' });
    await expect(f.standing(mcp).bulk({ schemaVersion: 1, scopeId: 'scope', commandId: 'b1', reason: { kind: 'reset', workClass: 'feature' }, targets: [target] })).rejects.toMatchObject({ code: 'AGENT_STANDING_REFUSED' });
    expect((await f.standing(person).bulk({ schemaVersion: 1, scopeId: 'scope', commandId: 'b2', reason: { kind: 'reset', workClass: 'feature' }, targets: [target] })).standings)
      .toMatchObject([{ standing: 'candidate', basis: { reasonCode: 'reset' } }]);
  });
  it('N35: restoring a narrowed agent decides the narrowing\'s suggestion, so the next window starts after it', async () => {
    const f = await catalogEvolutionFixture(roots, { overlay: { revision: 'site-1', rules: [{ id: 'redesign-agent', version: 2, kind: 'redesign-agent', status: 'calibrated', params: { minSamples: 10, upperBoundMicro: 500000 } }] } });
    await f.catalog().defineAgent(agentDefine('auditor', 'a1'));
    await f.signers.enrol(enrol(aggregator, 'e-aggregator'));
    await f.standing(person).change(change('promote', 'p1', 1));
    seedMetrics(f.path, ...agentTasks('auditor', 10, 1), ...plainTasks(10, 5));
    await f.evolution().runPass('scope', 'on');
    const narrowed = (await standingOf(f))!;
    expect(narrowed.standing).toBe('redesign-required');
    expect((await f.standing(person).change(change('restore', 'r1', narrowed.standingRevision))).standings[0]).toMatchObject({ standing: 'candidate' });
    const d1 = (await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 5 })).items.find(row => row.kind === 'redesign-agent')!;
    expect(d1).toMatchObject({ state: 'decided', decision: 'restore' });
    seedMetrics(f.path, ...agentTasks('auditor', 3, 0, 'after'));
    await f.evolution().runPass('scope', 'on');
    expect((await standingOf(f))!.standing).toBe('candidate');
  });
  it('N35: a reset card restoring a narrowed agent decides the narrowing\'s suggestion too (no re-narrowing without the cooldown)', async () => {
    const f = await catalogEvolutionFixture(roots, { overlay: { revision: 'site-1', rules: [{ id: 'redesign-agent', version: 2, kind: 'redesign-agent', status: 'calibrated', params: { minSamples: 10, upperBoundMicro: 500000 } }] } });
    await f.catalog().defineAgent(agentDefine('auditor', 'a1'));
    await f.signers.enrol(enrol(aggregator, 'e-aggregator'));
    await f.standing(person).change(change('promote', 'p1', 1));
    seedMetrics(f.path, ...agentTasks('auditor', 10, 1), ...plainTasks(10, 5));
    await f.evolution().runPass('scope', 'on');
    const narrowed = (await standingOf(f))!;
    await f.standing(person).bulk({ schemaVersion: 1, scopeId: 'scope', commandId: 'b1', reason: { kind: 'reset', workClass: 'feature' },
      targets: [{ agentId: 'auditor', revision: 1, workClass: 'feature', expectedStandingRevision: narrowed.standingRevision }] });
    expect((await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 5 })).items.find(row => row.kind === 'redesign-agent')).toMatchObject({ state: 'decided', decision: 'restore' });
    seedMetrics(f.path, ...agentTasks('auditor', 1, 0, 'after'));
    await f.evolution().runPass('scope', 'on');
    expect((await standingOf(f))!.standing).toBe('candidate');
  });
});

describe('signed AI commands (N1, N42, N46)', () => {
  it('without a key, without a grant, or with a grant over every WorkClass: refused; a grant naming the WorkClass and the actor\'s own key: allowed, basis signed', async () => {
    const f = await catalogEvolutionFixture(roots, { grants: [grant('mcp-all', mcp, ['promote', 'demote'], 'all'), grant('mcp-docs', remote, ['promote'], ['scope/docs'])] });
    await f.catalog().defineAgent(agentDefine('auditor', 'a1'));
    await expect(f.standing(mcp).change(change('promote', 'm1', 1))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await f.signers.enrol(enrol(mcp, 'e-mcp')); await f.signers.enrol(enrol(remote, 'e-remote'));
    await expect(f.standing(mcp).change(change('promote', 'm2', 1))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(f.standing(remote).change(change('promote', 'r1', 1))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    f.policy.grants.push(grant('remote-feature', remote, ['promote', 'demote'], ['scope/feature']));
    const done = await f.standing(remote).change(change('promote', 'r2', 1));
    expect(done.standings[0]).toMatchObject({ standing: 'active', basis: { kind: 'signed', decidedBy: { issuer: remote.issuer, ai: true }, signed: { keyId: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    expect(countRows(f.path, 'audit_events', "WHERE kind='agent-standing'")).toBe(1);
  });
  it('N42: an AI never promotes a revision it wrote; another signed, granted AI may (Q-S12)', async () => {
    const f = await catalogEvolutionFixture(roots, { grants: [grant('mcp-define', mcp, ['define']), grant('mcp-feature', mcp, ['promote'], ['scope/feature']),
      grant('remote-feature', remote, ['promote'], ['scope/feature'])] });
    await f.signers.enrol(enrol(mcp, 'e-mcp')); await f.signers.enrol(enrol(remote, 'e-remote'));
    await f.catalog(mcp).defineAgent(agentDefine('auditor', 'a1'));
    await expect(f.standing(mcp).change(change('promote', 'm1', 1))).rejects.toMatchObject({ code: 'AGENT_STANDING_REFUSED' });
    expect(await f.standing(remote).change(change('promote', 'r1', 1))).toMatchObject({ standings: [{ standing: 'active', basis: { decidedBy: { issuer: remote.issuer } } }] });
  });
  it('N41/N38: a revoked key stops its pending and replayed commands; its promotions stay and are listed; a person demotes them in one step', async () => {
    const f = await catalogEvolutionFixture(roots, { grants: [grant('remote-feature', remote, ['promote', 'demote'], ['scope/feature'])] });
    await f.catalog().defineAgent(agentDefine('auditor', 'a1'));
    const key = (await f.signers.enrol(enrol(remote, 'e-remote'))).item;
    await f.standing(remote).change(change('promote', 'r1', 1));
    await f.signers.revoke({ schemaVersion: 1, scopeId: 'scope', commandId: 'x1', keyId: key.keyId });
    await expect(f.standing(remote).change(change('promote', 'r1', 1))).rejects.toMatchObject({ code: 'CATALOG_SIGNER_REVOKED' });
    await expect(f.standing(remote).change(change('demote', 'r2', 2))).rejects.toMatchObject({ code: 'CATALOG_SIGNATURE_REQUIRED' });
    expect((await standingOf(f))!.standing).toBe('active');
    const listed = await f.standing(person).revokedPromotions({ schemaVersion: 1, scopeId: 'scope' });
    expect(listed).toMatchObject([{ keyId: key.keyId, standing: { agentId: 'auditor', standing: 'active' } }]);
    const targets = listed.map(row => ({ agentId: row.standing.agentId, revision: row.standing.revision, workClass: row.standing.workClass, expectedStandingRevision: row.standing.standingRevision }));
    await expect(f.standing(person).bulk({ schemaVersion: 1, scopeId: 'scope', commandId: 'b1', reason: { kind: 'signer-revoked', keyId: 'f'.repeat(64) }, targets })).rejects.toMatchObject({ code: 'AGENT_STANDING_REFUSED' });
    expect((await f.standing(person).bulk({ schemaVersion: 1, scopeId: 'scope', commandId: 'b2', reason: { kind: 'signer-revoked', keyId: key.keyId }, targets })).standings)
      .toMatchObject([{ standing: 'candidate', basis: { kind: 'person-card', reasonCode: 'signer-revoked' } }]);
    expect(await f.standing(person).revokedPromotions({ schemaVersion: 1, scopeId: 'scope' })).toEqual([]);
  });
});

describe('define from a suggestion (§6 fold A, N36)', () => {
  it('a person defines the proposed agent: its revision names the suggestion (template origin) and the suggestion is decided in the same commit; an AI may not', async () => {
    const f = await catalogEvolutionFixture(roots, { overlay: { revision: 'site-n', rules: [{ id: 'propose-agent', version: 2, kind: 'propose-agent', status: 'provisional', params: { minTasks: 3 } }] },
      grants: [grant('mcp-define', mcp, ['define'])] });
    await f.signers.enrol(enrol(aggregator, 'e-aggregator')); await f.signers.enrol(enrol(mcp, 'e-mcp'));
    seedMetrics(f.path, ...plainTasks(4, 4).map(row => ({ ...row, workClass: 'docs' })));
    await f.evolution().runPass('scope', 'on');
    const suggestion = (await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 5 })).items.find(row => row.kind === 'propose-agent')!;
    await expect(f.catalog(mcp).defineAgent({ ...agentDefine('writer', 'm1', null, ['docs']), fromSuggestion: suggestion.suggestionId })).rejects.toMatchObject({ code: 'AGENT_STANDING_REFUSED' });
    await expect(f.catalog().defineAgent({ ...agentDefine('writer', 'a0', null, ['feature']), fromSuggestion: suggestion.suggestionId })).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
    const made = await f.catalog().defineAgent({ ...agentDefine('writer', 'a1', null, ['docs']), fromSuggestion: suggestion.suggestionId });
    expect(made.item.provenance).toMatchObject({ author: { ai: false }, origin: { kind: 'template', suggestionId: suggestion.suggestionId, template: 'agent-draft@1', lessonSetDigest: null } });
    expect((await f.standing(person).inspectSuggestion({ schemaVersion: 1, scopeId: 'scope', suggestionId: suggestion.suggestionId }))).toMatchObject({ item: { state: 'decided', decision: 'define' } });
    await expect(f.catalog().defineAgent({ ...agentDefine('second', 'a2', null, ['docs']), fromSuggestion: suggestion.suggestionId })).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
    expect(countRows(f.path, 'agent_definitions')).toBe(1);
  });
  it('N36: a skill defined from a lesson suggestion carries `lessons-derived` and its lesson-set digest; the same set is never suggested again', async () => {
    const lesson = (id: string) => ({ entryId: id, revision: 1, contentDigest: id.repeat(32).slice(0, 64), audience: null });
    const f = await catalogEvolutionFixture(roots, { lessons: [lesson('a1'), lesson('b2'), lesson('c3')] });
    await f.signers.enrol(enrol(aggregator, 'e-aggregator'));
    seedMetrics(f.path, ...plainTasks(1, 1));
    await f.evolution().runPass('scope', 'on');
    const suggestion = (await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 5 })).items.find(row => row.kind === 'propose-skill')!;
    const made = await f.catalog().defineSkill({ schemaVersion: 1, scopeId: 'scope', commandId: 'k1', skillId: 'lessons', expectedRevision: null, content: { name: 'Dersler', text: 'Metin.' },
      fromSuggestion: suggestion.suggestionId });
    expect(made.item.provenance.origin).toEqual({ kind: 'lessons-derived', suggestionId: suggestion.suggestionId, template: 'skill-draft@1',
      lessonSetDigest: suggestion.proposed.kind === 'skill-draft' ? suggestion.proposed.lessonSetDigest : null });
    seedMetrics(f.path, ...plainTasks(1, 1, 'more'));
    await f.evolution().runPass('scope', 'on');
    expect((await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', open: true, limit: 5 })).items.filter(row => row.kind === 'propose-skill')).toEqual([]);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try { expect(String(db.prepare("SELECT record FROM audit_events WHERE kind='catalog-suggestion'").all().map(row => row['record']).join())).not.toContain('Metin'); } finally { db.close(); }
  });
});
