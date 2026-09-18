import { expect, it } from 'vitest';
import { createRun, reserveRunTasks, observeRunAttempt, createAttempt, applyAttemptObservation, inspectTaskEvaluation, requestRunCancellation } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const identity = { runId: 'r', scopeId: 's', layoutRevision: 'l', taskId: 'a', attemptId: 'attempt', generation: 1 };
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['content', 'behavior'] }, { id: 'b', kind: 'custom', dependencies: ['a'], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: ['content', 'behavior', 'verified'].map(id => ({ id, version: 1, description: `Verify ${id}`, evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} })) };
function fixture(exitCode = 0) {
  const reserved = reserveRunTasks(createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph)), 0, [identity], 0);
  const attempt = applyAttemptObservation(createAttempt(identity), { protocolVersion: 1, identity, sequence: 1, eventId: 'exit', result: { kind: 'exited', exitCode } }, 0);
  return observeRunAttempt(reserved, 1, attempt);
}
const evaluation = { schemaVersion: 1, evaluationId: 'evaluation', identity, graphRevision: 1, attemptRevision: 1,
  criteria: [{ criterionId: 'behavior', verdict: 'pass', evidenceIds: ['z', 'a'] }, { criterionId: 'content', verdict: 'pass', evidenceIds: ['proof'] }] };
it('binds and normalizes criteria without accepting a Task, opening dependencies or using process exit as a verdict', () => {
  for (const exitCode of [0, 7]) {
    const run = fixture(exitCode); const before = JSON.stringify(run); const result = inspectTaskEvaluation(run, evaluation);
    expect(result.conclusion).toBe('pass'); expect(result.evaluation.criteria.map(value => value.criterionId)).toEqual(['content', 'behavior']);
    expect(result.evaluation.criteria[1]!.evidenceIds).toEqual(['a', 'z']); expect(JSON.stringify(run)).toBe(before);
    expect(run.progress.map(value => value.phase)).toEqual(['evaluating', 'pending']);
  }
});
it('keeps unknown distinct from concrete failure and rejects unsupported positive claims', () => {
  const run = fixture();
  const criteria = [{ criterionId: 'content', verdict: 'unknown', evidenceIds: [] }, { criterionId: 'behavior', verdict: 'pass', evidenceIds: ['proof'] }];
  expect(inspectTaskEvaluation(run, { ...evaluation, criteria }).conclusion).toBe('unknown');
  expect(inspectTaskEvaluation(run, { ...evaluation, criteria: [criteria[0], { ...criteria[1], verdict: 'fail' }] }).conclusion).toBe('fail');
  expect(() => inspectTaskEvaluation(run, { ...evaluation, criteria: criteria.map(value => ({ ...value, verdict: 'pass', evidenceIds: [] })) })).toThrow('TASK_EVALUATION_INVALID');
});
it.each([{ graphRevision: 2 }, { attemptRevision: 2 }, { identity: { ...identity, scopeId: 'foreign' } }, { identity: { ...identity, generation: 2 } }, { identity: { ...identity, attemptId: 'other' } }])('rejects foreign or stale evaluation %j', changes => {
  expect(() => inspectTaskEvaluation(fixture(), { ...evaluation, ...changes })).toThrow('TASK_EVALUATION_STALE');
});
it.each([
  [evaluation.criteria[0]], [evaluation.criteria[0], evaluation.criteria[0]],
  [evaluation.criteria[0], { ...evaluation.criteria[1], criterionId: 'invented' }],
].map(criteria => ({ criteria })))('requires exact declared criterion coverage %j', ({ criteria }) => {
  expect(() => inspectTaskEvaluation(fixture(), { ...evaluation, criteria })).toThrow('TASK_EVALUATION_CRITERIA');
});
it('refuses caller verdict/actor injection, duplicate evidence and cancelled or uncertain work', () => {
  const run = fixture();
  for (const extra of [{ decision: 'accept' }, { actor: 'admin' }]) expect(() => inspectTaskEvaluation(run, { ...evaluation, ...extra })).toThrow('TASK_EVALUATION_INVALID');
  expect(() => inspectTaskEvaluation(run, { ...evaluation, criteria: evaluation.criteria.map(value => ({ ...value, evidenceIds: ['same', 'same'] })) })).toThrow('TASK_EVALUATION_INVALID');
  expect(() => inspectTaskEvaluation(requestRunCancellation(run, run.revision), evaluation)).toThrow('TASK_EVALUATION_NOT_READY');
  expect(() => inspectTaskEvaluation({ ...run, progress: run.progress.map(value => value.taskId === 'a' ? { ...value, phase: 'reconciling', unresolvedEffects: true } : value) }, evaluation)).toThrow('TASK_EVALUATION_NOT_READY');
});
