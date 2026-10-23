import { describe, expect, it } from 'vitest';
import { composeCatalogEvolutionRegistry, deckentMetricsSchema } from '#domain/index.js';
import { catalogEntries, effortRatioMicro, keyStats, rollupStats } from '#engine/index.js';
import { DAY, NOW, feed, metric, type MetricSpec } from '../support/catalog-metrics.js';

// S8-2 (S8-DESIGN §4, §12): the pure aggregation over sealed metrics v2 rows. Only accepted outcomes and attributable failures (failed criteria,
// the worker's own report, a person's rejection) enter n; a container crash, a model substitution, a dependency, a policy refusal, an operator
// cancel and a failure with no recorded cause are their own buckets that no rule reads. Expected values are hand-counted.
const registry = composeCatalogEvolutionRegistry();
const agentA = (spec: MetricSpec & { daysAgo?: number | null }) => ({ agent: ['agent-a', 1] as const, ...spec });
const ofAgent = (agentId: string, revision = 1) => (row: { workClass: string | null; agent: { agentId: string; revision: number } | null }) =>
  row.workClass === 'feature' && row.agent?.agentId === agentId && row.agent.revision === revision;
const stats = (rows: ReturnType<typeof feed>, match = ofAgent('agent-a'), overlay?: unknown, facts?: Parameters<typeof keyStats>[4]) =>
  keyStats(catalogEntries('scope', rows), composeCatalogEvolutionRegistry(overlay), NOW, match, facts);

describe('what counts (fold B)', () => {
  it('N30/N31: only accepted and attributable failures enter n; every other cause and a cause-less failure is its own bucket', () => {
    const rows = feed(...['a1', 'a2', 'a3'].map(task => agentA({ task })), agentA({ task: 'c', status: 'failed', cause: 'criteria-failed' }),
      agentA({ task: 'w', status: 'failed', cause: 'worker-report-failed' }), agentA({ task: 'h', status: 'failed', cause: 'human-rejected', decision: 'human', kinds: ['exit-code', 'human-decision'] }),
      agentA({ task: 'i1', status: 'failed', cause: 'infra' }), agentA({ task: 'i2', status: 'failed', cause: 'infra' }), agentA({ task: 'm', status: 'failed', cause: 'model' }),
      agentA({ task: 'd', status: 'failed', cause: 'dependency' }), agentA({ task: 'p', status: 'failed', cause: 'policy' }), agentA({ task: 'o', status: 'failed', cause: 'operator' }),
      agentA({ task: 'u', status: 'failed' }));
    expect(stats(rows)).toMatchObject({ decided: 13, n: 6, successes: 3, wilson: { lowerMicro: 187612, upperMicro: 812388 },
      failures: { 'criteria-failed': 1, 'worker-report-failed': 1, 'human-rejected': 1 },
      unattributable: { infra: 2, model: 1, dependency: 1, policy: 1, operator: 1, unattributed: 1 }, nonAttributableShareMicro: 538461 });
  });
  it('N30: a window of only crashes, substitutions and cancels has no counted outcome and no interval', () => {
    const rows = feed(agentA({ task: 'i', status: 'failed', cause: 'infra' }), agentA({ task: 'm', status: 'failed', cause: 'model' }), agentA({ task: 'o', status: 'failed', cause: 'operator' }));
    expect(stats(rows)).toMatchObject({ decided: 3, n: 0, successes: 0, wilson: null, nonAttributableShareMicro: 1000000 });
  });
  it('N7: one Task counts once — the current row of its highest Attempt (an earlier infra failure does not count)', () => {
    const rows = feed(agentA({ task: 't', attempt: 1, status: 'failed', cause: 'infra' }), agentA({ task: 't', attempt: 2 }));
    expect(stats(rows)).toMatchObject({ decided: 1, n: 1, successes: 1, unattributable: { infra: 0 } });
  });
  it('N6: for one Attempt the later current row wins (a human decision after the system row)', () => {
    const rows = feed(agentA({ task: 't', status: 'awaiting-decision' }), agentA({ task: 't', status: 'failed', cause: 'human-rejected', decision: 'human', kinds: ['exit-code', 'human-decision'] }));
    expect(stats(rows)).toMatchObject({ n: 1, successes: 0, failures: { 'human-rejected': 1 }, excluded: { awaitingDecision: 0 }, effort: { humanDecisions: 1 } });
  });
  it('N8: awaiting-decision, quota-park and Run-incomplete rows are never success or failure; they are counted apart', () => {
    const rows = feed(agentA({ task: 'w', status: 'awaiting-decision' }), agentA({ task: 'q', kind: 'quota-park' }), agentA({ task: 'q', kind: 'quota-park', attempt: 2 }),
      agentA({ task: 'r', kind: 'run' }));
    expect(stats(rows)).toMatchObject({ decided: 0, n: 0, wilson: null, excluded: { awaitingDecision: 1, quotaPark: 2, runIncomplete: 1 } });
  });
  it('N32: a row whose only evidence is `unknown` stays out of n and is shown apart; mixed evidence counts; the parameter can turn it off', () => {
    const rows = feed(agentA({ task: 'u', kinds: ['unknown'] }), agentA({ task: 'x', kinds: ['exit-code', 'unknown'] }));
    expect(stats(rows)).toMatchObject({ n: 1, decided: 1, excluded: { unknownEvidence: 1 } });
    expect(stats(rows, ofAgent('agent-a'), { revision: 'site', stats: { excludeUnknownEvidence: false } })).toMatchObject({ n: 2, excluded: { unknownEvidence: 0 } });
  });
  it('a row without a sealed time never enters an age-bounded window; it is counted as undated', () => {
    expect(stats(feed(agentA({ task: 'x', daysAgo: null }), agentA({ task: 'y' })))).toMatchObject({ n: 1, excluded: { undated: 1 } });
  });
  it('pre-v2 rows are set apart as legacy, never counted', () => {
    const base: Record<string, unknown> = { ...metric({ task: 'old' }), schemaVersion: 1, outcome: { kind: 'task', status: 'failed' } };
    for (const v2Only of ['effort', 'actualModel', 'evidenceKinds', 'acceptanceScore']) delete base[v2Only];
    const legacy = deckentMetricsSchema.parse(base);
    const entries = catalogEntries('scope', [{ position: 1, digest: '1'.padStart(64, '0'), atMs: NOW - DAY, metric: legacy }]);
    expect(keyStats(entries, registry, NOW, row => row.workClass === 'feature')).toMatchObject({ n: 0, decided: 0, excluded: { legacy: 1 } });
  });
  it('N9: a row of another scope is a corrupt feed, never pooled', () => {
    expect(() => catalogEntries('scope', feed({ task: 'x', scope: 'other' }))).toThrow(expect.objectContaining({ code: 'CATALOG_EVOLUTION_CORRUPT' }));
  });
});
describe('windows', () => {
  it('the last windowTasks decided Tasks no older than windowMaxDays, cited by a reproducible digest of (position, record digest)', () => {
    const rows = feed(agentA({ task: 'old', daysAgo: 31 }), agentA({ task: 'a', status: 'failed', cause: 'criteria-failed' }), agentA({ task: 'b' }), agentA({ task: 'c' }));
    const narrow = { revision: 'site', stats: { windowTasks: 2 } }, first = stats(rows, ofAgent('agent-a'), narrow);
    expect(first).toMatchObject({ decided: 2, n: 2, successes: 2, window: { tasks: 2, firstPosition: 3, lastPosition: 4, inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(stats(rows, ofAgent('agent-a'), narrow).window.inputDigest).toBe(first.window.inputDigest);
    expect(stats(rows).window).toMatchObject({ tasks: 3, firstPosition: 2 }); expect(stats(rows).window.inputDigest).not.toBe(first.window.inputDigest);
  });
  it('periods are the distinct non-overlapping periods (registry length) the counted outcomes fall in; models the distinct exact models', () => {
    const periodDays = registry.stats.periodDays, start = Math.floor(NOW / (periodDays * DAY)) * periodDays * DAY, daysAgo = (at: number) => (NOW - at) / DAY;
    const rows = feed(agentA({ task: 'a', daysAgo: daysAgo(start + DAY / 2) }), agentA({ task: 'b', daysAgo: daysAgo(start - DAY / 2), model: ['channel-b', 'model-b'] }),
      agentA({ task: 'c', daysAgo: daysAgo(start - DAY) }));
    expect(stats(rows)).toMatchObject({ periods: 2, models: 2 });
  });
});
describe('effort and the model dimension', () => {
  it('duration p50/p90 by nearest rank, measured cost summed exactly in nanos, pinned vs system-assigned, effort mix', () => {
    const rows = feed(agentA({ task: 'a', durationMs: 40, cost: '1000000000000000000001', effort: 'high' }), agentA({ task: 'b', durationMs: 10, cost: '2', assigned: true }),
      agentA({ task: 'c', durationMs: 30, effort: 'high' }), agentA({ task: 'd', durationMs: 20, model: null }), agentA({ task: 'e', durationMs: null }));
    expect(stats(rows).effort).toMatchObject({ p50Ms: 20, p90Ms: 40, costUsdNanos: '1000000000000000000003', costRows: 2, pinned: 3, assigned: 1, effortMix: { high: 2 } });
  });
  it('effort ratio is the key p50 over the baseline p50 in micro-units; none without durations', () => {
    const rows = feed(agentA({ task: 'a', durationMs: 300 }), { task: 'b', durationMs: 200, agent: ['agent-b', 1] }), entries = catalogEntries('scope', rows);
    const own = keyStats(entries, registry, NOW, ofAgent('agent-a')), base = keyStats(entries, registry, NOW, row => row.workClass === 'feature' && row.agent?.agentId !== 'agent-a');
    expect(effortRatioMicro(own, base)).toBe(1500000);
    expect(effortRatioMicro(own, keyStats(entries, registry, NOW, () => false))).toBeNull();
  });
  it('N19: the per-model split resolves maker and tier at read time; absent facts are `unknown`; the split is capped by modelMixMax', () => {
    const rows = feed(agentA({ task: 'a' }), agentA({ task: 'b' }), agentA({ task: 'c', model: ['channel-b', 'model-b'], status: 'failed', cause: 'criteria-failed' }));
    const facts = (channelId: string) => channelId === 'channel-a' ? { maker: 'maker-a', tier: 'worker' } : { maker: null, tier: null };
    expect(stats(rows, ofAgent('agent-a'), undefined, facts).perModel).toEqual([
      { channelId: 'channel-a', modelId: 'model-a', maker: 'maker-a', tier: 'worker', n: 2, successes: 2 },
      { channelId: 'channel-b', modelId: 'model-b', maker: 'unknown', tier: 'unknown', n: 1, successes: 0 }]);
    expect(stats(rows, ofAgent('agent-a'), { revision: 'site', stats: { modelMixMax: 1 } }, facts)).toMatchObject({ perModel: [{ modelId: 'model-a' }], otherModels: 1 });
    expect(stats(rows).perModel).toBeNull();
  });
});
describe('baseline and org roll-up', () => {
  it('the WorkClass baseline excludes this agent; rows without an agent count only toward the baseline', () => {
    const rows = feed(agentA({ task: 'a' }), { task: 'b', agent: ['agent-b', 1], status: 'failed', cause: 'criteria-failed' }, { task: 'c', agent: null });
    const entries = catalogEntries('scope', rows);
    expect(keyStats(entries, registry, NOW, row => row.workClass === 'feature' && row.agent?.agentId !== 'agent-a')).toMatchObject({ n: 2, successes: 1 });
    expect(keyStats(entries, registry, NOW, ofAgent('agent-a'))).toMatchObject({ n: 1, successes: 1 });
    expect(keyStats(entries, registry, NOW, row => row.workClass === 'feature')).toMatchObject({ n: 3, successes: 2 });
  });
  it('a roll-up sums the members\' counts and computes Wilson on the sum (display only)', () => {
    const entries = catalogEntries('scope', feed(...Array.from({ length: 18 }, (_, i) => agentA({ task: `a${i}` })), { task: 'f', agent: ['agent-b', 1], status: 'failed', cause: 'criteria-failed' },
      { task: 'g', agent: ['agent-b', 1], status: 'failed', cause: 'infra' }, { task: 'h', agent: ['agent-b', 1] }));
    const members = [keyStats(entries, registry, NOW, ofAgent('agent-a')), keyStats(entries, registry, NOW, ofAgent('agent-b'))];
    expect(rollupStats('feature', members, registry)).toEqual({ workClass: 'feature', members: 2, decided: 21, n: 20, successes: 19, wilson: { lowerMicro: 763864, upperMicro: 991119 },
      failures: { 'criteria-failed': 1, 'worker-report-failed': 0, 'human-rejected': 0 }, unattributable: { infra: 1, model: 0, dependency: 0, policy: 0, operator: 0, unattributed: 0 } });
  });
});
