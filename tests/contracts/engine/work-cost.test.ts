import { expect, it, vi } from 'vitest';
import { createRun, summarizeWorkCosts, type RunSnapshot, type VerifiedPrincipal } from '#domain/index.js';
import { projectAttemptWorkCost, inspectRunWorkCosts, unavailableResourceView } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['ok'] }],
  criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'process-exit', version: 1 }, parameters: {} }] };
function run(): RunSnapshot { const base = createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
  return { ...base, bindings: [{ identity, observedKind: 'exited', observedRevision: 1 }], progress: [{ taskId: 't', phase: 'accepted', unresolvedEffects: false, eligibility: { kind: 'immediate' } }] } as RunSnapshot; }
const resources = { ...unavailableResourceView(), cpuSeconds: 2, sampledPeakBytes: 123, sampleCount: 2 };
const cost = () => projectAttemptWorkCost(run(), identity, resources, null, undefined, undefined, null);
it('keeps absent tariff, local usage and human/rollback evidence unknown, with no all-axis money total', () => {
  expect(cost()).toMatchObject({ identity, coverage: 'partial', axes: { cpuSeconds: 2, apiMoney: null, humanInterventions: null, localModel: null },
    quality: { interventionCount: null, rollbackCount: null, reworkCount: null, followup: 'unknown' } });
  const report = summarizeWorkCosts({ scopeId: 's', runId: 'r', runRevision: 1, observedAtMs: 100, withheld: 0, attempts: [cost(), cost()] });
  expect(report.attempts).toHaveLength(1); expect(report.summary).toMatchObject({ acceptedTasks: 1, measuredCpuSeconds: 2, sampledCpuSecondsPerAcceptedTask: 2, measuredApiUsdNanos: null });
});
it('rejects duplicate conflicting evidence and another scope/attempt; no accepted denominator means unknown unit cost', () => {
  const row = cost(); expect(() => summarizeWorkCosts({ scopeId: 's', runId: 'r', runRevision: 1, observedAtMs: 100, withheld: 0, attempts: [row, { ...row, axes: { ...row.axes, cpuSeconds: 4 } }] })).toThrow('WORK_COST_REPLAY_CONFLICT');
  expect(() => projectAttemptWorkCost(run(), { ...identity, attemptId: 'other' }, resources, null, undefined, undefined, null)).toThrow('WORK_COST_IDENTITY');
  const report = summarizeWorkCosts({ scopeId: 's', runId: 'r', runRevision: 1, observedAtMs: 100, withheld: 0, attempts: [{ ...row, acceptance: { ...row.acceptance, outcome: 'incomplete' } }] });
  expect(report.summary.sampledCpuSecondsPerAcceptedTask).toBeNull();
});
it('does not read denied worker values, metrics or usage and excludes them from totals', async () => {
  const readResources = vi.fn(async () => resources), readDispatch = vi.fn(async () => null), readMetrics = vi.fn(async () => []), readEvents = vi.fn(async () => null);
  const report = await inspectRunWorkCosts(run(), [], {} as VerifiedPrincipal, { readResources, readDispatch, readMetrics, readEvents, now: () => 100 }, async () => { throw new Error('POLICY_DENIED'); });
  expect(readResources).not.toHaveBeenCalled(); expect(readDispatch).not.toHaveBeenCalled(); expect(readMetrics).not.toHaveBeenCalled(); expect(readEvents).not.toHaveBeenCalled();
  expect(report).toMatchObject({ attempts: [], withheld: 1, summary: { measuredCpuSeconds: null, measuredApiUsdNanos: null, sampledCpuSecondsPerAcceptedTask: null } });
});
// ATAMA-0 read path: a v2 metric row supplies the human-decision count and the model evidence label; v1 or absent rows stay unknown.
function pinnedRun(): RunSnapshot {
  const copy = JSON.parse(JSON.stringify(run()));
  copy.execution.tasks[0].profile.parameters = { fixture: true, nativeSubscription: { provider: 'claude', model: { channelId: 'claude', modelId: 'claude-opus-5-5', auxiliaryModelIds: [] } } };
  return copy;
}
const metric = (decision: 'system' | 'human', verdict: string) => ({ schemaVersion: 2 as const, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a' },
  workClass: null, policyRevision: null, profileVersion: null, skillSetDigest: null, model: { channelId: 'claude', modelId: 'claude-opus-5-5' }, durationMs: null, cost: null,
  attemptSequence: 1, evidenceReferences: [], effort: null, outcome: { kind: 'task' as const, status: 'accepted' as const, decision },
  actualModel: { reported: 'claude-opus-5-5', verdict, evidence: 'sealed' as const, capability: 'session-events' as const }, evidenceKinds: [], acceptanceScore: null });
it.each([['system', 'verified', 0, 'verified'], ['human', 'verified', 1, 'verified'], ['system', 'substituted', 0, 'unknown'], ['system', 'start-name-matched', 0, 'requested']] as const)(
  'a v2 %s row with a %s model verdict counts %i human decisions and labels the model %s', (decision, verdict, human, evidence) => {
    const row = projectAttemptWorkCost(pinnedRun(), identity, resources, null, metric(decision, verdict), undefined, null);
    expect(row.axes.humanInterventions).toBe(human); expect(row.model).toEqual({ channelId: 'claude', modelId: 'claude-opus-5-5', evidence });
  });
it('a pinned Attempt without a v2 row keeps the requested label and an unknown human count', () => {
  const row = projectAttemptWorkCost(pinnedRun(), identity, resources, null, undefined, undefined, null);
  expect(row.axes.humanInterventions).toBeNull(); expect(row.model?.evidence).toBe('requested');
});
