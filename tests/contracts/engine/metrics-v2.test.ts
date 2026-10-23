import { expect, it } from 'vitest';
import { bindTaskAcceptance, deckentMetricsSchema, type RunSnapshot } from '#domain/index.js';
import { deriveAcceptanceMetrics, dispatchRecordSchema } from '#engine/index.js';
import { evaluating, evidence, identity } from '../domain/acceptance-fixture.js';

// ATAMA-0 (metrics v2): the row a success ledger needs: effort, the worker's reported model with its evidence label, duration from the
// host-observed container, the evidence kind of the verdict, human decisions and quota parks. Expected values are literals from the fixture.
const actor = { id: 'actor', issuer: 'test', subject: 'author' };
const effort = { schemaVersion: 1, level: 'high', source: 'policy-default', status: 'selected', workClass: 'business', policyRevision: 'business-r1', target: 'high' } as const;
function pinned(run: RunSnapshot): RunSnapshot {
  const copy = JSON.parse(JSON.stringify(run));
  copy.execution.tasks[0].profile.parameters = { nativeSubscription: { provider: 'claude', reasoningEffort: effort,
    model: { channelId: 'claude', modelId: 'claude-opus-5-5', auxiliaryModelIds: [] } } };
  return copy;
}
function dispatch(container?: { startedAt: string | null; finishedAt: string | null }) {
  return dispatchRecordSchema.parse({ schemaVersion: 2, owner: 'worker-owner', launch: 'granted',
    profile: { schemaVersion: 1, adapterId: 'test', adapterVersion: 1, parameters: {} },
    request: { protocolVersion: 1, identity, workspace: '/fixture', argv: ['fixture-command'] },
    grant: { generation: 1, grantedAt: 1, principal: actor },
    terminal: { handle: 'handle', exitCode: 0, interrupted: false, ...(container ? { container: { schemaVersion: 1, containerId: 'c'.repeat(64), imageId: `sha256:${'e'.repeat(64)}`,
      resources: { cpus: 1, memoryBytes: 1024, pids: 64, tmpBytes: 1024 }, ...container } } : {}) },
    output: { schemaVersion: 1, scopeId: identity.scopeId, digest: 'a'.repeat(64), byteLength: 10 } });
}
const model = { provider: 'claude', requested: { channelId: 'claude', modelId: 'claude-opus-5-5', auxiliaryModelIds: [] },
  init: 'claude-opus-5-5', usage: ['claude-opus-5-5'], verdict: 'verified', unexpected: [], evidence: 'sealed', evidenceCapability: 'session-events' } as const;
function evaluationCommand(run: RunSnapshot, extra: Record<string, unknown> = {}, container?: Parameters<typeof dispatch>[0]) {
  return JSON.stringify({ action: 'apply-task-evaluation', commandId: 'evaluation', actor, expectedRevision: run.revision,
    evaluation: { ...bindTaskAcceptance(run, evidence()), ...extra }, dispatch: dispatch(container) });
}
function accepted(run: RunSnapshot): RunSnapshot {
  return { ...run, revision: run.revision + 1, progress: run.progress.map(row => ({ ...row, phase: 'accepted' as const })) } as RunSnapshot;
}

it('an evaluation row records effort, the reported model and its evidence label, container duration, evidence kind and score', () => {
  const { run } = evaluating(), before = pinned(run);
  const [metric] = deriveAcceptanceMetrics(evaluationCommand(before, { model }, { startedAt: '2026-10-23T10:00:00.000Z', finishedAt: '2026-10-23T10:02:30.000Z' }), accepted(before));
  expect(metric).toMatchObject({ schemaVersion: 2, outcome: { kind: 'task', status: 'accepted', decision: 'system' },
    model: { channelId: 'claude', modelId: 'claude-opus-5-5' }, effort,
    actualModel: { reported: 'claude-opus-5-5', verdict: 'verified', evidence: 'sealed', capability: 'session-events' },
    durationMs: 150_000, evidenceKinds: ['unknown'], acceptanceScore: 1, skillSetDigest: null, attemptSequence: 1 });
  expect(deckentMetricsSchema.parse(metric)).toEqual(metric);
});
it('an unpinned row and an unfinished container interval stay explicitly null, never invented', () => {
  const { run } = evaluating();
  const [plain] = deriveAcceptanceMetrics(evaluationCommand(run), accepted(run));
  expect(plain).toMatchObject({ effort: null, actualModel: null, model: null, durationMs: null });
  const [unfinished] = deriveAcceptanceMetrics(evaluationCommand(run, {}, { startedAt: '2026-10-23T10:02:30.000Z', finishedAt: null }), accepted(run));
  expect(unfinished!.durationMs).toBeNull();
});
it('a quota park writes its own quota-park row instead of a task outcome', () => {
  const { run } = evaluating();
  const quota = { signal: { source: 'claude-rate-limit', resetsAtMs: 6000 }, channelId: 'claude', evidenceDigest: 'd'.repeat(64), maxResumes: 3 };
  const rows = deriveAcceptanceMetrics(evaluationCommand(run, { quota, criteria: evidence('unknown').criteria }), run);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.outcome).toEqual({ kind: 'quota-park', channelId: 'claude' });
  expect(rows[0]!.evidenceKinds).toEqual([]);
});
function decision(run: RunSnapshot, action: 'accept' | 'reject') {
  return JSON.stringify({ operation: 'run-lifecycle', schemaVersion: 1, commandId: `decide-${action}`, scopeId: identity.scopeId, runId: identity.runId,
    expectedRevision: run.revision, action, taskId: identity.taskId, actor: { ...actor, assurance: 'os-user' }, now: 200, timeoutMs: 1000 });
}
it.each([['accept', 'accepted'], ['reject', 'failed']] as const)('a human %s writes a task row marked human and carries the system row measurements', (action, status) => {
  const { run } = evaluating(), before = pinned(run);
  const [system] = deriveAcceptanceMetrics(evaluationCommand(before, { model }, { startedAt: '2026-10-23T10:00:00.000Z', finishedAt: '2026-10-23T10:00:01.000Z' }), accepted(before));
  const after = { ...before, revision: before.revision + 2, progress: before.progress.map(row => ({ ...row, phase: status })) } as RunSnapshot;
  const [human, ...rest] = deriveAcceptanceMetrics(decision(after, action), after, system);
  expect(rest).toEqual([]);
  expect(human).toMatchObject({ outcome: { kind: 'task', status, decision: 'human' }, durationMs: 1000, effort,
    actualModel: { verdict: 'verified' }, evidenceKinds: ['human-decision', 'unknown'], acceptanceScore: 1 });
  // Without a prior system row the human row is still recorded, with no invented measurements.
  const [alone] = deriveAcceptanceMetrics(decision(after, action), after, null);
  expect(alone).toMatchObject({ outcome: { kind: 'task', status, decision: 'human' }, durationMs: null, actualModel: null, evidenceKinds: ['human-decision'], acceptanceScore: null });
});
it('a stall retry is not an outcome and writes no row', () => {
  const { run } = evaluating();
  const pending = { ...run, progress: run.progress.map(row => ({ ...row, phase: 'pending' as const })) } as unknown as RunSnapshot;
  expect(deriveAcceptanceMetrics(evaluationCommand(run, { stall: { cause: 'inactivity', backoffMs: 10 }, criteria: evidence('unknown').criteria }), pending)).toEqual([]);
});
it('historical v1 rows stay readable beside v2 rows', () => {
  const v1 = { schemaVersion: 1, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a' }, workClass: null, policyRevision: null, profileVersion: null,
    skillSetDigest: null, model: null, outcome: { kind: 'task', status: 'accepted' }, durationMs: null, cost: null, attemptSequence: 1, evidenceReferences: [] };
  expect(deckentMetricsSchema.parse(v1)).toEqual(v1);
  expect(() => deckentMetricsSchema.parse({ ...v1, schemaVersion: 2 })).toThrow();
});
