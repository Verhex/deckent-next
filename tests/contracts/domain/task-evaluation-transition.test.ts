import { expect, it } from 'vitest';
import { createRun, reserveRunTasks, observeRunAttempt, createAttempt, applyAttemptObservation, applyTaskEvaluation, inspectTaskReadiness } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const identity = { runId: 'r', scopeId: 's', layoutRevision: 'l', taskId: 'a', attemptId: 'attempt', generation: 1 };
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] }, { id: 'b', kind: 'custom', dependencies: ['a'], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify task result', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
function fixture() {
  const reserved = reserveRunTasks(createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph)), 0, [identity], 0);
  const attempt = applyAttemptObservation(createAttempt(identity), { protocolVersion: 1, identity, sequence: 1, eventId: 'exit', result: { kind: 'exited', exitCode: 7 } }, 0);
  return { run: observeRunAttempt(reserved, 1, attempt), attempt };
}
function evaluation(verdict: 'pass' | 'fail' | 'unknown') {
  return { schemaVersion: 1, evaluationId: 'e', identity, graphRevision: 1, attemptRevision: 1,
    criteria: [{ criterionId: 'verified', verdict, evidenceIds: verdict === 'unknown' ? [] : ['proof'] }] };
}
it.each([
  ['pass', 'accepted', 'ready'], ['fail', 'failed', 'terminal'], ['unknown', 'awaiting-decision', 'waiting'],
] as const)('proposes %s and dependency disposition without mutating original execution evidence', (verdict, phase, disposition) => {
  const f = fixture(); const before = JSON.stringify(f); const result = applyTaskEvaluation(f.run, f.run.revision, evaluation(verdict), { now: 100, timeoutMs: 1000 });
  expect(result.snapshot.progress[0]!.phase).toBe(phase); expect(result.snapshot.revision).toBe(f.run.revision + 1);
  expect(result.snapshot.bindings).toEqual(f.run.bindings); expect(JSON.stringify(f)).toBe(before);
  const ready = inspectTaskReadiness(graph, { graphRevision: graph.revision, progress: result.snapshot.progress, now: 0 });
  expect(ready.find(task => task.taskId === 'b')!.disposition).toBe(disposition);
});
it('consumes a revision even for HOLD and refuses acceptance replay as a new transition', () => {
  const { run } = fixture(); const hold = applyTaskEvaluation(run, run.revision, evaluation('unknown'), { now: 100, timeoutMs: 1000 });
  expect(() => applyTaskEvaluation(hold.snapshot, run.revision, evaluation('pass'), { now: 100, timeoutMs: 1000 })).toThrow('RUN_REVISION_CONFLICT');
  expect(() => applyTaskEvaluation(hold.snapshot, hold.snapshot.revision, evaluation('pass'), { now: 100, timeoutMs: 1000 })).toThrow('TASK_EVALUATION_NOT_READY');
});
it('does not reopen accepted Tasks through newer execution observations', () => {
  const { run, attempt } = fixture(); const accepted = applyTaskEvaluation(run, run.revision, evaluation('pass'), { now: 100, timeoutMs: 1000 });
  expect(() => observeRunAttempt(accepted.snapshot, accepted.snapshot.revision, { ...attempt, revision: attempt.revision + 1 })).toThrow('RUN_ATTEMPT_CONFLICT');
});
it('trusted narrowing policy can fail unknown immediately without changing the original evaluation evidence', () => {
  const { run } = fixture(); const evidence = evaluation('unknown');
  const result = applyTaskEvaluation(run, run.revision, evidence, { now: 50, timeoutMs: 100, unknownDisposition: 'fail' });
  expect(result.conclusion).toBe('unknown');
  expect(result.evaluation).toEqual(evidence);
  expect(result.snapshot.progress[0]).toMatchObject({ phase: 'failed' });
  expect(result.snapshot.progress[0]!.decision).toBeUndefined();
  expect(result.snapshot.progress[1]).toMatchObject({ phase: 'skipped', skippedReason: 'dependency-failed' });
  expect(result.snapshot.state).toMatchObject({ kind: 'parked', reason: 'dependency-failed' });
  expect(run.progress[0]!.phase).toBe('evaluating');
});

it('new evidence permits one pure return, retains deadline on unknown, and cannot replay the consumed digest', () => {
  const { run } = fixture(); const first = 'a'.repeat(64), recovered = 'b'.repeat(64);
  const parked = applyTaskEvaluation(run, run.revision, { ...evaluation('unknown'), evidenceDigests: [first] }, { now: 100, timeoutMs: 1000 }).snapshot;
  const evidence = { ...evaluation('unknown'), evaluationId: 'return', evidenceDigests: [first, recovered], returnEvidence: { kind: 'output', digest: recovered } };
  const returned = applyTaskEvaluation(parked, parked.revision, evidence, { now: 200, timeoutMs: 9000 }).snapshot;
  expect(returned.progress[0]!.decision).toMatchObject({ since: 100, deadline: 1100, evidenceDigests: [first, recovered] });
  expect(returned.state).toEqual(parked.state);
  expect(() => applyTaskEvaluation(returned, returned.revision, { ...evidence, evaluationId: 'again' }, { now: 300, timeoutMs: 1000 })).toThrow('TASK_EVALUATION_NOT_READY');
  expect(() => applyTaskEvaluation(parked, parked.revision, evidence, { now: 1100, timeoutMs: 1000 })).toThrow('TASK_EVALUATION_NOT_READY');
  expect(() => applyTaskEvaluation(parked, parked.revision, { ...evidence, returnEvidence: undefined }, { now: 200, timeoutMs: 1000 })).toThrow('TASK_EVALUATION_NOT_READY');
});
