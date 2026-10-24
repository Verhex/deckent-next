import { describe, expect, it } from 'vitest';
import { agentStandingSchema, defineAgentRevision, initialAgentStandings, taskAgentSealSchema, transitionAgentStanding, type AgentDefinition, type AgentStanding } from '#domain/index.js';

// S8-1a (S8-DESIGN §7): one standing per (agent revision, WorkClass): candidate | active | redesign-required | retired, moved only by a pure
// transition table under compare-and-set on `standingRevision`. A definition opens every bound WorkClass as `candidate`; a person-authored
// revision inherits `active` only for a WorkClass both revisions bind and only with an identical skill set or local-only skill changes.
const person = { issuer: 'local-os', subject: 'uid:1000', assurance: 'os-user' }, ai = { issuer: 'local-os/mcp', subject: 'uid:1000', assurance: 'os-user' };
const d = (c: string) => c.repeat(64);
const content = (workClasses = ['feature', 'docs']) => ({ name: 'Fatura denetçisi', persona: 'Faturaları siparişle eşleştirir.', workClasses, skills: [], parentAgentId: null });
const define = (previous: AgentDefinition | null, author = person, workClasses?: string[], skillSetDigest = d('c')) => defineAgentRevision(previous, { scopeId: 's',
  agentId: 'auditor', commandId: `c${(previous?.revision ?? 0) + 1}`, content: content(workClasses), personaDigest: d('b'), skillSetDigest, author, atMs: 5,
  // S8-5: an AI-authored row carries the key and signature digest verified at commit.
  ...(author.issuer.endsWith('/mcp') ? { signed: { keyId: d('e'), signatureDigest: d('f') } } : {}) });
const card = { issuer: 'local-os', subject: 'uid:1000', ai: false }, aiActor = { issuer: 'local-os/mcp', subject: 'uid:1000', ai: true };
const promoted = (row: AgentStanding): AgentStanding => agentStandingSchema.parse({ ...row, standing: 'active', standingRevision: row.standingRevision + 1,
  basis: { kind: 'person-card', decidedBy: card, atMs: 9, commandId: 'p', suggestionId: null, reasonCode: null } });

describe('initial standings at definition', () => {
  it('a new agent opens every bound WorkClass as candidate (basis definition, standing revision 1)', () => {
    const rows = initialAgentStandings(define(null), null, false);
    expect(rows.map(row => [row.workClass, row.standing, row.standingRevision, row.basis.kind])).toEqual([['feature', 'candidate', 1, 'definition'], ['docs', 'candidate', 1, 'definition']]);
    expect(rows.every(row => agentStandingSchema.safeParse(row).success && row.revision === 1 && row.agentId === 'auditor')).toBe(true);
  });
  it('N14/N40: a person-authored revision inherits active for a WorkClass both revisions bind; a newly bound WorkClass starts candidate', () => {
    const first = define(null), rows = initialAgentStandings(first, null, false), active = [promoted(rows[0]!), rows[1]!];
    const second = define(first, person, ['feature', 'docs', 'review']);
    const next = initialAgentStandings(second, { definition: first, standings: active }, false);
    expect(next.map(row => [row.workClass, row.standing, row.basis.kind, row.basis.fromRevision ?? null])).toEqual([
      ['feature', 'active', 'inherited', 1], ['docs', 'candidate', 'definition', null], ['review', 'candidate', 'definition', null]]);
    // The previous revision's rows are not touched: they stay as they are (history), the new revision is a new key.
    expect(active[0]!.revision).toBe(1);
  });
  it('N43: an AI-authored revision, or one adding/changing an imported skill, never inherits (always candidate)', () => {
    const first = define(null), active = initialAgentStandings(first, null, false).map(promoted);
    expect(initialAgentStandings(define(first, ai), { definition: first, standings: active }, false).every(row => row.standing === 'candidate')).toBe(true);
    const changed = define(first, person, undefined, d('e'));
    expect(initialAgentStandings(changed, { definition: first, standings: active }, true).every(row => row.standing === 'candidate')).toBe(true);
    // Local-only skill changes keep the inheritance.
    expect(initialAgentStandings(changed, { definition: first, standings: active }, false).every(row => row.standing === 'active')).toBe(true);
  });
  it('negative: never inherits from redesign-required or retired', () => {
    const first = define(null), rows = initialAgentStandings(first, null, false);
    const narrowed = rows.map(row => agentStandingSchema.parse({ ...row, standing: 'redesign-required', standingRevision: 2,
      basis: { kind: 'rule', decidedBy: aiActor, atMs: 9, commandId: null, suggestionId: d('f'), reasonCode: 'D1', signed: { keyId: d('e'), signatureDigest: d('f') } } }));
    expect(initialAgentStandings(define(first), { definition: first, standings: narrowed }, false).every(row => row.standing === 'candidate')).toBe(true);
  });
});

describe('standing transitions (pure table; S8-4 cards and S8-5 signed AI commands call it)', () => {
  const start = () => initialAgentStandings(define(null), null, false)[0]!;
  it('promote moves candidate → active and turns the WorkClass\'s current active agent into candidate in the same change', () => {
    const other = agentStandingSchema.parse({ ...promoted(start()), agentId: 'other' });
    const [target, displaced] = transitionAgentStanding(start(), { action: 'promote', expectedStandingRevision: 1, actor: card, atMs: 10, commandId: 'k', suggestionId: null, displaced: other });
    expect(target).toMatchObject({ standing: 'active', standingRevision: 2, basis: { kind: 'person-card', commandId: 'k' } });
    expect(displaced).toMatchObject({ agentId: 'other', standing: 'candidate', standingRevision: 3 });
  });
  it('demote, restore and retire follow the table; retired is final', () => {
    const active = promoted(start());
    expect(transitionAgentStanding(active, { action: 'demote', expectedStandingRevision: 2, actor: card, atMs: 10, commandId: 'k', suggestionId: null })[0]).toMatchObject({ standing: 'candidate', standingRevision: 3 });
    const retired = transitionAgentStanding(active, { action: 'retire', expectedStandingRevision: 2, actor: card, atMs: 10, commandId: 'k', suggestionId: null })[0]!;
    expect(retired.standing).toBe('retired');
    for (const action of ['promote', 'demote', 'restore', 'retire'] as const)
      expect(() => transitionAgentStanding(retired, { action, expectedStandingRevision: 3, actor: card, atMs: 11, commandId: 'k2', suggestionId: null })).toThrow(expect.objectContaining({ code: 'AGENT_STANDING_REFUSED' }));
  });
  it('N12: a stale standing revision is a compare-and-set conflict; nothing is produced', () => {
    expect(() => transitionAgentStanding(start(), { action: 'promote', expectedStandingRevision: 2, actor: card, atMs: 10, commandId: 'k', suggestionId: null }))
      .toThrow(expect.objectContaining({ code: 'AGENT_STANDING_CONFLICT' }));
  });
  it('negative: an AI principal moves no standing unsigned (S8-4 signed path: agent-standing-signed.test.ts); narrowing needs a sealed rule suggestion and its signature; demote of a candidate is refused', () => {
    for (const action of ['promote', 'demote', 'restore', 'retire'] as const)
      expect(() => transitionAgentStanding(start(), { action, expectedStandingRevision: 1, actor: aiActor, atMs: 10, commandId: 'k', suggestionId: null })).toThrow(expect.objectContaining({ code: 'AGENT_STANDING_REFUSED' }));
    expect(() => transitionAgentStanding(start(), { action: 'narrow', expectedStandingRevision: 1, actor: card, atMs: 10, commandId: 'k', suggestionId: null })).toThrow(expect.objectContaining({ code: 'AGENT_STANDING_REFUSED' }));
    expect(() => transitionAgentStanding(start(), { action: 'narrow', expectedStandingRevision: 1, actor: aiActor, atMs: 10, commandId: null, suggestionId: d('f'), reasonCode: 'D1' }))
      .toThrow(expect.objectContaining({ code: 'AGENT_STANDING_REFUSED' }));
    expect(transitionAgentStanding(start(), { action: 'narrow', expectedStandingRevision: 1, actor: aiActor, atMs: 10, commandId: null, suggestionId: d('f'), reasonCode: 'D1',
      signed: { keyId: d('e'), signatureDigest: d('f') } })[0])
      .toMatchObject({ standing: 'redesign-required', basis: { kind: 'rule', suggestionId: d('f'), reasonCode: 'D1' } });
    expect(() => transitionAgentStanding(start(), { action: 'demote', expectedStandingRevision: 1, actor: card, atMs: 10, commandId: 'k', suggestionId: null })).toThrow(expect.objectContaining({ code: 'AGENT_STANDING_REFUSED' }));
  });
});

it('the task seal names an exact agent revision, its digests and pins, the standing it was chosen with and why; a model id is never part of it', () => {
  const seal = { schemaVersion: 1, agentId: 'auditor', revision: 2, workClass: 'feature', personaDigest: d('b'), skillSetDigest: d('c'), skills: [{ skillId: 'k', revision: 1, digest: d('a') }],
    standing: 'candidate', standingRevision: 1, selection: { eligible: 2, position: 0, reason: 'first-candidate' } };
  expect(taskAgentSealSchema.parse(seal)).toEqual(seal);
  expect(taskAgentSealSchema.safeParse({ ...seal, standing: 'retired' }).success).toBe(false);
  expect(taskAgentSealSchema.safeParse({ ...seal, modelId: 'claude-opus-5-5' }).success).toBe(false);
});
