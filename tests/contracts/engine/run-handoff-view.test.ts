import { expect, it } from 'vitest';
import { createAttempt, createRun, type RunSnapshot } from '#domain/index.js';
import { handoffEventCommandId, projectRunView, projectMonitorRun, RunInspectionApplication, type RunPoolEvidence } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const graph = { schemaVersion: 2, revision: 1, tasks: [
  { id: 'a', kind: 'coding', dependencies: [], acceptanceCriteria: ['ok'] },
  { id: 'b', kind: 'coding', dependencies: ['a'], acceptanceCriteria: ['ok'] }],
  criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'process-exit', version: 1 }, parameters: {} }] };
const identity = (taskId: string) => ({ scopeId: 's', runId: 'r', layoutRevision: 'l', taskId, attemptId: `attempt-${taskId}`, generation: 1 });
const base = createRun({ scopeId: 's', runId: 'r', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
const run = { ...base, progress: base.progress.map(task => ({ ...task, phase: task.taskId === 'a' ? 'accepted' : 'active' })),
  bindings: ['a', 'b'].map(task => ({ identity: identity(task), observedRevision: null, observedKind: null })) } as RunSnapshot;
const event = { kind: 'handoff-received' as const, source: identity('a'), digest: 'a'.repeat(64) };
const record = { schemaVersion: 1 as const, identity: identity('b'), events: [event] };
it('derives an exact accepted dependency receipt; existence of a dependency does not prove receipt', () => {
  expect(projectRunView(run).tasks[1]).not.toHaveProperty('handoffs');
  expect(projectRunView(run, [record]).tasks[1]?.handoffs).toEqual([{ source: identity('a'), digest: event.digest }]);
});
it.each(['failed', 'skipped', 'awaiting-decision'])('never projects a handoff from a %s predecessor', phase => {
  const changed = { ...run, bindings: run.bindings.map(binding => phase === 'awaiting-decision' && binding.identity.taskId === 'a' ? { ...binding, observedKind: 'exited', observedRevision: 1 } : binding), progress: run.progress.map(task => task.taskId === 'a' ? { ...task, phase, ...(phase === 'skipped' ? { skippedReason: 'dependency-failed' } : {}),
    ...(phase === 'awaiting-decision' ? { decision: { reason: 'evaluation-unknown', since: 1, deadline: 2 } } : {}) } : task) };
  expect(projectRunView(changed, [record]).tasks[1]).not.toHaveProperty('handoffs');
});
it('refuses wrong source attempt, foreign scope, and wrong receiving attempt in projection', () => {
  for (const source of [{ ...event.source, attemptId: 'wrong' }, { ...event.source, scopeId: 'foreign' }, { ...event.source, generation: 2 }]) {
    expect(projectRunView(run, [{ ...record, events: [{ ...event, source }] }]).tasks[1]).not.toHaveProperty('handoffs');
  }
  expect(projectRunView(run, [{ ...record, identity: { ...record.identity, attemptId: 'wrong' } }]).tasks[1]).not.toHaveProperty('handoffs');
});
it('does not turn workspace patch evidence into a received note', () => {
  expect(projectRunView(run, [{ ...record, events: [{ ...event, kind: 'workspace-started-from-patch' }] }]).tasks[1]).not.toHaveProperty('handoffs');
});

it('monitor shares the engine dependency receipt projection and withholds a wrong source attempt', () => {
  const attempt = { attemptId: 'attempt-b', generation: 1, observedKind: null, observedRevision: null, dispatch: null,
    evaluationObserved: false, reservedAtMs: null, sealedAtMs: null, handoffStart: record };
  const evidence = { run: { snapshot: run, poolId: null, admitted: true, createdAtMs: null, attempts: [attempt] },
    approvals: [], pool: null, workers: new Map(), observedAt: 10 };
  expect(projectMonitorRun(evidence).tasks[1]?.handoffs).toEqual([{ source: identity('a'), digest: event.digest }]);
  expect(projectMonitorRun({ ...evidence, run: { ...evidence.run, attempts: [{ ...attempt,
    handoffStart: { ...record, events: [{ ...event, source: { ...event.source, attemptId: 'wrong' } }] } }] } }).tasks[1]?.handoffs).toEqual([]);
});

it('authenticated inspection retains pool waits and drift alongside exact handoff receipts from the pool snapshot', async () => {
  const combinedGraph = { ...graph, tasks: [...graph.tasks, { id: 'c', kind: 'coding', dependencies: ['a'], acceptanceCriteria: ['ok'] }] };
  const created = createRun(run.identity, combinedGraph, 0, fixtureExecution(combinedGraph));
  const snapshot = { ...created, progress: [...run.progress, created.progress[2]!], bindings: run.bindings };
  const capacity = { executionSlots: 2, inFlightSlots: 2 };
  const evidence: RunPoolEvidence = { snapshot, pool: { poolId: 'p', capacity,
    runCapacity: { executionSlots: 8, inFlightSlots: 8 }, occupancy: { execution: 2, inFlight: 2 }, hold: null, admitted: true } };
  const before = JSON.stringify(evidence);
  const app = new RunInspectionApplication({
    async loadRun() { throw new Error('inspection must use the pool snapshot'); },
    async loadRunPoolEvidence() { return evidence; },
    async receipt(scopeId, commandId) {
      expect(scopeId).toBe('s');
      return commandId === handoffEventCommandId(record.identity)
        ? { command: JSON.stringify(record), snapshot: createAttempt(record.identity) } : null;
    },
  }, { async verify() { return { id: 'u', issuer: 'host', subject: '1', assurance: 'os-user', scopeIds: ['s'] }; } },
  { async authorize() {} }, undefined, { admission: { poolId: 'p', executionSlots: 8, inFlightSlots: 8 }, ceiling: 2 });
  const view = await app.inspect({ schemaVersion: 1, scopeId: 's', runId: 'r' });
  expect(view?.tasks[1]?.handoffs).toEqual([{ source: identity('a'), digest: event.digest }]);
  expect(view?.tasks[0]).not.toHaveProperty('handoffs');
  expect(view?.pool?.drift.map(value => value.source)).toEqual(['run', 'admission']);
  expect(view?.pool?.waiting).toEqual([{ taskId: 'c', reason: { code: 'waiting-pool-slot', poolId: 'p', capacity,
    effectiveCapacity: capacity, occupancy: { execution: 2, inFlight: 2 }, sinceMs: null } }]);
  expect(JSON.stringify(evidence)).toBe(before);
});
