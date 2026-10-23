import { describe, expect, it } from 'vitest';
import { agentStandingSchema, composeCatalogEvolutionRegistry, type AgentStanding } from '#domain/index.js';
import { agentRuleCandidates, catalogEntries, catalogSuggestionRecord, catalogSuggestionSchema, keepWindow, keyStats, lessonRuleCandidates, lessonSetDigest, mergeEntries,
  workClassRuleCandidates, type CatalogEntries } from '#engine/index.js';
import { DAY, NOW, feed, type MetricSpec } from '../support/catalog-metrics.js';

// S8-3 (S8-DESIGN §6, §12): rules P1/D1/R1/N1/S1 over sealed statistics; every seed provisional. Only accepted outcomes and attributable failures count;
// a rule reads no model id or maker (models are distinct exact ids, N19). Windows of one (key, kind) never overlap and re-open only after the cooldown.
const registry = composeCatalogEvolutionRegistry();
const calibrated = composeCatalogEvolutionRegistry({ revision: 'site-1', rules: [{ id: 'redesign-agent', version: 2, kind: 'redesign-agent', status: 'calibrated',
  params: { minSamples: 10, upperBoundMicro: 500000 } }] });
const key = { kind: 'agent' as const, agentId: 'agent-a', revision: 1, workClass: 'feature' };
const standing = (value: AgentStanding['standing'] = 'candidate', basis: 'definition' | 'inherited' = 'definition'): AgentStanding => agentStandingSchema.parse({ schemaVersion: 1, scopeId: 'scope',
  agentId: 'agent-a', revision: 1, workClass: 'feature', standing: value, standingRevision: 1,
  basis: { kind: basis, decidedBy: { issuer: 'local-os', subject: 'uid:1000', ai: false }, atMs: 1, commandId: 'c', suggestionId: null, reasonCode: null, ...(basis === 'inherited' ? { fromRevision: 1 } : {}) } });
type Spec = MetricSpec & { daysAgo?: number };
/** `n` Tasks of agent-a over two models and two periods (days 1 and 9 ago): `accepted` of them accepted, the rest attributable failures. */
const agentRows = (n: number, accepted: number, extra: Partial<Spec> = {}) => Array.from({ length: n }, (_, i): Spec => ({ task: `a${i}`, agent: ['agent-a', 1], daysAgo: i % 2 ? 1 : 9,
  model: ['channel-a', i % 2 ? 'model-a' : 'model-b'], ...(i < accepted ? {} : { status: 'failed', cause: 'criteria-failed' }), ...extra }));
const baselineRows = (n: number, accepted: number) => Array.from({ length: n }, (_, i): Spec => ({ task: `b${i}`, agent: null, ...(i < accepted ? {} : { status: 'failed', cause: 'worker-report-failed' }) }));
const entriesOf = (...specs: Spec[]) => catalogEntries('scope', feed(...specs));
const split = (entries: CatalogEntries) => ({ own: { tasks: entries.tasks.filter(row => row.agent?.agentId === 'agent-a'), events: [] }, workClass: entries });
const run = (entries: CatalogEntries, overrides: Partial<Parameters<typeof agentRuleCandidates>[0]> = {}) =>
  agentRuleCandidates({ registry, asOfMs: NOW, key, standing: standing(), ...split(entries), active: null, closed: {}, ...overrides });

describe('P1 promote (§6)', () => {
  it('fires on 20 of 20 above the baseline over two models; the proposal is standing → active; the window cites rows by position + digest', () => {
    const [candidate] = run(entriesOf(...agentRows(20, 20), ...baselineRows(10, 5)));
    expect(candidate).toMatchObject({ kind: 'promote-agent', key, rule: { id: 'promote-agent', version: 1, status: 'provisional' }, proposed: { kind: 'standing', to: 'active' },
      window: { after: 0, n: 20, tasks: 20 } });
    expect(candidate!.window.inputDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('N5: below `minSamples` — no suggestion', () => {
    expect(run(entriesOf(...agentRows(19, 19), ...baselineRows(10, 5)))).toEqual([]);
  });
  it('N33: lower bound ≥ 0.70 but not above the baseline, not above the active agent, or all on one model in one period — no promote suggestion', () => {
    expect(run(entriesOf(...agentRows(20, 20), ...baselineRows(10, 10))).map(row => row.kind)).toEqual([]);
    const active = { agentId: 'agent-b', revision: 1, entries: { tasks: entriesOf(...Array.from({ length: 20 }, (_, i): Spec => ({ task: `c${i}`, agent: ['agent-b', 1] }))).tasks, events: [] } };
    expect(run(entriesOf(...agentRows(20, 20), ...baselineRows(10, 5)), { active }).map(row => row.kind)).toEqual([]);
    const one = agentRows(20, 20).map(row => ({ ...row, daysAgo: 1, model: ['channel-a', 'model-a'] as const }));
    expect(run(entriesOf(...one, ...baselineRows(10, 5)))).toEqual([]);
    // No baseline data is never "above the baseline" (conservative; the person may still promote on a card).
    expect(run(entriesOf(...agentRows(20, 20)))).toEqual([]);
  });
  it('N37: a non-attributable share above `maxNonAttributableShare` — no promote suggestion even when every other condition holds', () => {
    const crashes = Array.from({ length: 6 }, (_, i): Spec => ({ task: `x${i}`, agent: ['agent-a', 1], status: 'failed', cause: 'infra' }));
    expect(run(entriesOf(...agentRows(20, 20), ...crashes, ...baselineRows(10, 5)))).toEqual([]);
  });
  it('N19: the rule reads no maker or tier — an unknown maker changes nothing', () => {
    const rows = entriesOf(...agentRows(20, 20), ...baselineRows(10, 5));
    const facts = () => ({ maker: null, tier: null });
    expect(run(rows, { facts }).map(row => row.kind)).toEqual(run(rows).map(row => row.kind));
  });
});

describe('D1 redesign and R1 revise', () => {
  it('D1 fires on a confident upper bound below 0.50 (1 of 10); an inherited promotion is re-checked on `inherit.recheckMinSamples` of its own outcomes', () => {
    const rows = entriesOf(...agentRows(10, 1), ...baselineRows(10, 5));
    expect(run(rows, { standing: standing('active') }).map(row => [row.kind, row.proposed])).toEqual([['redesign-agent', { kind: 'standing', to: 'redesign-required' }]]);
    expect(run(rows, { standing: standing('active', 'inherited') }).map(row => row.kind)).toEqual(['redesign-agent']);
    expect(run(entriesOf(...agentRows(9, 1), ...baselineRows(10, 5)), { standing: standing('active') })).toEqual([]);
  });
  it('N30: crashes, substitutions, policy refusals and cancels never count toward D1', () => {
    const noise = ['infra', 'model', 'policy', 'operator', 'dependency'].flatMap(cause => Array.from({ length: 4 }, (_, i): Spec => ({ task: `${cause}${i}`, agent: ['agent-a', 1], status: 'failed', cause })));
    expect(run(entriesOf(...noise, ...agentRows(3, 3)), { standing: standing('active') })).toEqual([]);
  });
  it('R1 fires on a slow agent (effort ratio ≥ 1.5) or a persistently middling one (both halves between the D1 and P1 bounds)', () => {
    const slow = agentRows(10, 9).map(row => ({ ...row, durationMs: 3000 }));
    expect(run(entriesOf(...slow, ...baselineRows(10, 5)), { standing: standing('active') }).map(row => row.kind)).toEqual(['revise-agent']);
    // 40 Tasks at 75%: each half of 20 has a Wilson lower bound ≈ 0.53, inside [0.50, 0.70).
    const middling = agentRows(40, 30).map((row, i) => ({ ...row, task: `m${i}`, ...(i % 4 === 3 ? { status: 'failed' as const, cause: 'criteria-failed' } : { status: 'accepted' as const, cause: undefined }) }));
    expect(run(entriesOf(...middling, ...baselineRows(10, 5)), { standing: standing('active') }).map(row => row.kind)).toEqual(['revise-agent']);
  });
  it('retired and redesign-required revisions get no agent suggestion', () => {
    for (const value of ['retired', 'redesign-required'] as const) expect(run(entriesOf(...agentRows(20, 20), ...baselineRows(10, 5)), { standing: standing(value) })).toEqual([]);
  });
});

describe('non-overlapping windows and the cooldown (N35)', () => {
  it('`after` keeps the previous window out; a closed key re-opens only with `cooldownTasks` new counted Tasks', () => {
    const rows = entriesOf(...agentRows(20, 20), ...baselineRows(10, 5));
    const last = Math.max(...rows.tasks.filter(row => row.agent).map(row => row.position));
    expect(keyStats(rows, registry, NOW, row => row.agent !== null, undefined, last).n).toBe(0);
    expect(run(rows, { closed: { 'promote-agent': last } })).toEqual([]);
    const tight = composeCatalogEvolutionRegistry({ revision: 'site-2', rules: [{ id: 'redesign-agent', version: 2, kind: 'redesign-agent', status: 'provisional', params: { minSamples: 3, upperBoundMicro: 900000 } }] });
    const failing = entriesOf(...agentRows(12, 0, { daysAgo: 1 }));
    // After a decided window, 3 new attributable failures fire D1 without a closed window, but not with one until 10 (cooldownTasks) new Tasks exist.
    const standingActive = standing('active');
    expect(agentRuleCandidates({ registry: tight, asOfMs: NOW, key, standing: standingActive, ...split(failing), active: null, closed: { 'redesign-agent': 9 } }).map(row => row.kind)).toEqual([]);
    expect(agentRuleCandidates({ registry: tight, asOfMs: NOW, key, standing: standingActive, ...split(failing), active: null, closed: { 'redesign-agent': 2 } }).map(row => row.kind)).toEqual(['redesign-agent']);
  });
});

describe('N1 propose-agent and S1 propose-skill', () => {
  it('N1 fires for a WorkClass with enough counted Tasks and no active or candidate agent; the draft is a template reference, never text', () => {
    const rows = entriesOf(...baselineRows(10, 7));
    expect(workClassRuleCandidates({ registry, asOfMs: NOW, workClass: 'feature', entries: rows, eligibleAgents: 0 })).toMatchObject([{ kind: 'propose-agent',
      key: { kind: 'work-class', workClass: 'feature' }, proposed: { kind: 'agent-draft', template: 'agent-draft@1' } }]);
    expect(workClassRuleCandidates({ registry, asOfMs: NOW, workClass: 'feature', entries: rows, eligibleAgents: 1 })).toEqual([]);
    expect(workClassRuleCandidates({ registry, asOfMs: NOW, workClass: 'feature', entries: entriesOf(...baselineRows(9, 9)), eligibleAgents: 0 })).toEqual([]);
  });
  it('S1 fires on ≥ 3 verified lessons of one audience not yet covered; the record holds refs and the set digest only', () => {
    const lesson = (id: string, family = 'feature') => ({ entryId: id, revision: 2, contentDigest: id.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/g, 'a'), audience: { workClassFamily: family, workTargetId: null } });
    const lessons = [lesson('l1'), lesson('l2'), lesson('l3'), lesson('d1', 'docs'), lesson('d2', 'docs')];
    const [candidate] = lessonRuleCandidates({ registry, lessons, covered: new Set() });
    expect(candidate).toMatchObject({ kind: 'propose-skill', key: { kind: 'audience', workClassFamily: 'feature', workTargetId: null }, proposed: { kind: 'skill-draft', template: 'skill-draft@1' } });
    expect(candidate!.proposed.kind === 'skill-draft' && candidate!.proposed.lessons.map(row => row.entryId)).toEqual(['l1', 'l2', 'l3']);
    expect(JSON.stringify(candidate)).not.toMatch(/title|body|correction/);
    const digest = candidate!.proposed.kind === 'skill-draft' ? candidate!.proposed.lessonSetDigest : '';
    expect(digest).toBe(lessonSetDigest(lessons.slice(0, 3)));
    expect(lessonRuleCandidates({ registry, lessons, covered: new Set([digest]) })).toEqual([]);
  });
});

describe('sealed record and replay (N10)', () => {
  it('the id is the digest of the whole content: same inputs → same id and bytes; another mode or time → another id', () => {
    const [candidate] = run(entriesOf(...agentRows(20, 20), ...baselineRows(10, 5)));
    const context = { scopeId: 'scope', mode: 'shadow' as const, producer: { issuer: 'local-os/catalog-aggregator', subject: 'uid:1000' }, asOfMs: NOW, registry, registryRef: { revision: 'r', digest: 'a'.repeat(64) } };
    const first = catalogSuggestionRecord(candidate!, context), again = catalogSuggestionRecord(candidate!, context);
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(catalogSuggestionSchema.parse(first)).toEqual(first);
    expect(first.expiresAtMs).toBe(NOW + registry.suggestions.suggestionTtlDays * DAY);
    expect(catalogSuggestionRecord(candidate!, { ...context, mode: 'on' }).suggestionId).not.toBe(first.suggestionId);
    expect(catalogSuggestionRecord(candidate!, { ...context, asOfMs: NOW + 1 }).suggestionId).not.toBe(first.suggestionId);
  });
  it('N34: a corrupt registry overlay yields no registry, so no rule can run', () => {
    expect(() => composeCatalogEvolutionRegistry({ revision: 'x', rules: [{ id: 'promote-agent', version: 1, kind: 'promote-agent' }] })).toThrow(expect.objectContaining({ code: 'CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE' }));
  });
  it('a calibrated D1 row is carried on the candidate (the caller narrows only on calibrated + mode on)', () => {
    expect(agentRuleCandidates({ registry: calibrated, asOfMs: NOW, key, standing: standing('active'), ...split(entriesOf(...agentRows(10, 1), ...baselineRows(10, 5))), active: null, closed: {} })[0]!.rule)
      .toEqual({ id: 'redesign-agent', version: 2, status: 'calibrated' });
  });
});

describe('incremental windows (S8-3: O(new rows) with a bounded rebuild)', () => {
  it('merging page by page keeps exactly the statistics of one full read; a later Attempt or human decision replaces the Task\'s earlier row', () => {
    const specs: Spec[] = [...agentRows(70, 50), { task: 'a3', attempt: 2 }, { task: 'a60', status: 'failed', cause: 'human-rejected', decision: 'human', kinds: ['exit-code', 'human-decision'] },
      { task: 'q', kind: 'quota-park' }, { task: 'u', kinds: ['unknown'] }];
    const rows = feed(...specs.map(spec => ({ agent: ['agent-a', 1] as const, ...spec })));
    let held: CatalogEntries = { tasks: [], events: [] };
    for (let start = 0; start < rows.length; start += 7) held = keepWindow(mergeEntries(held, catalogEntries('scope', rows.slice(start, start + 7))), registry);
    const all = catalogEntries('scope', rows), match = () => true;
    const { window: a, ...incremental } = keyStats(held, registry, NOW, match), { window: b, ...full } = keyStats(all, registry, NOW, match);
    expect(incremental).toEqual(full);
    expect(a).toEqual(b);
    expect(held.tasks.length).toBeLessThanOrEqual(2 * registry.stats.windowTasks);
  });
});
