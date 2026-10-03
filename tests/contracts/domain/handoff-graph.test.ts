import { expect, it } from 'vitest';
import { validateTaskGraph, inspectTaskReadiness, TASK_GRAPH_SCHEMA_VERSION } from '#domain/index.js';
const definition = { id: 'ok', version: 1, description: 'OK', evaluator: { id: 'test', version: 1 }, parameters: {} };
const task = (id: string, dependencies: unknown[] = []) => ({ id, kind: 'code', dependencies, acceptanceCriteria: ['ok'] });
const graph = (dependencies: unknown[], version = 4) => ({ schemaVersion: version, revision: 1, tasks: [task('a'), task('b', dependencies)], criterionDefinitions: [definition] });
it('v4 retains declared accepted-patch edges while old graphs read with unchanged fixed-base semantics', () => {
  expect(TASK_GRAPH_SCHEMA_VERSION).toBe(4);
  expect(validateTaskGraph(graph([{ taskId: 'a', startFrom: 'accepted-patch' }])).tasks[1]!.dependencies).toEqual([{ taskId: 'a', startFrom: 'accepted-patch' }]);
  for (const version of [2, 3]) expect(validateTaskGraph(graph(['a'], version))).toEqual(graph(['a'], version));
  expect(validateTaskGraph(graph([{ taskId: 'a' }])).tasks[1]!.dependencies).toEqual([{ taskId: 'a' }]);
});
it('rejects startFrom in old graph versions and duplicate edges through mixed representations', () => {
  for (const version of [2, 3]) expect(() => validateTaskGraph(graph([{ taskId: 'a', startFrom: 'accepted-patch' }], version))).toThrow('TASK_GRAPH_INVALID');
  expect(() => validateTaskGraph(graph(['a', { taskId: 'a', startFrom: 'accepted-patch' }]))).toThrow('TASK_DEPENDENCY_DUPLICATE');
  expect(() => validateTaskGraph(graph([{ taskId: 'a', startFrom: 'branch' }]))).toThrow('TASK_GRAPH_INVALID');
});
it('accepted-patch requests never bypass canonical predecessor acceptance', () => {
  const progress = (taskId: string, phase: string) => ({ taskId, phase, unresolvedEffects: false, eligibility: { kind: 'immediate' } });
  const input = graph([{ taskId: 'a', startFrom: 'accepted-patch' }]);
  for (const phase of ['failed', 'skipped', 'evaluating']) {
    const predecessor = phase === 'skipped' ? { ...progress('a', phase), skippedReason: 'dependency-failed' } : progress('a', phase);
    expect(inspectTaskReadiness(input, { graphRevision: 1, now: 1, progress: [predecessor, progress('b', 'pending')] })[1]!.disposition).toBe(phase === 'evaluating' ? 'waiting' : 'blocked');
  }
  expect(inspectTaskReadiness(input, { graphRevision: 1, now: 1, progress: [progress('a', 'accepted'), progress('b', 'pending')] })[1]!.disposition).toBe('ready');
});
