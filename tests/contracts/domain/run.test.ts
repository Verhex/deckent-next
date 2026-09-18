import { expect, it } from 'vitest';
import { createRun, reserveRunTasks, observeRunAttempt, requestRunCancellation, runSnapshotSchema,
  createAttempt, applyAttemptObservation, inspectTaskReadiness } from '#domain/index.js';
const identity = { runId: 'r', scopeId: 's', layoutRevision: 'layout' };
const graph = { schemaVersion: 2, revision: 1, tasks: [
  { id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] },
  { id: 'b', kind: 'custom', dependencies: ['a'], acceptanceCriteria: ['verified'] },
], criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify task result', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const attemptIdentity = { ...identity, taskId: 'a', attemptId: 'attempt-a', generation: 1 };
it('binds ready tasks to exact attempts without opening dependencies on process exit zero', () => {
  const created = createRun(identity, graph, 10);
  expect(() => reserveRunTasks(created, 0, [{ ...attemptIdentity, taskId: 'b' }], 10)).toThrow('RUN_TASK_NOT_READY');
  const reserved = reserveRunTasks(created, 0, [attemptIdentity], 10);
  const attempt = applyAttemptObservation(createAttempt(attemptIdentity), { protocolVersion: 1, identity: attemptIdentity, sequence: 1, eventId: 'exited', result: { kind: 'exited', exitCode: 0 } }, 0);
  const observed = observeRunAttempt(reserved, 1, attempt);
  expect(observed.progress[0]!.phase).toBe('evaluating'); expect(observed.progress[1]!.phase).toBe('pending');
  expect(inspectTaskReadiness(observed.graph, { graphRevision: 1, now: 10, progress: observed.progress })[1]!.disposition).toBe('waiting');
  expect(() => reserveRunTasks(observed, 2, [{ ...attemptIdentity, taskId: 'b', attemptId: 'b' }], 10)).toThrow('RUN_TASK_NOT_READY');
  expect(created.revision).toBe(0); expect(Object.isFrozen(observed.bindings[0]!.identity)).toBe(true);
});
it('keeps uncertain effects held even after later exit evidence', () => {
  const reserved = reserveRunTasks(createRun(identity, graph, 0), 0, [attemptIdentity], 0);
  const unknown = applyAttemptObservation(createAttempt(attemptIdentity), { protocolVersion: 1, identity: attemptIdentity, sequence: 1, eventId: 'lost', result: { kind: 'unknown', reasonCode: 'disconnected' } }, 0);
  const held = observeRunAttempt(reserved, 1, unknown);
  const exited = applyAttemptObservation(unknown, { protocolVersion: 1, identity: attemptIdentity, sequence: 2, eventId: 'found', result: { kind: 'exited', exitCode: 0 } }, 1);
  const recovered = observeRunAttempt(held, 2, exited);
  expect(recovered.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
});
it('rejects stale revisions, duplicated attempts and foreign evidence', () => {
  const run = createRun(identity, graph, 0);
  expect(() => reserveRunTasks(run, 1, [attemptIdentity], 0)).toThrow('RUN_REVISION_CONFLICT');
  expect(() => reserveRunTasks(run, 0, [attemptIdentity, attemptIdentity], 0)).toThrow('RUN_ATTEMPT_CONFLICT');
  expect(() => reserveRunTasks(run, 0, [{ ...attemptIdentity, scopeId: 'foreign' }], 0)).toThrow('RUN_ATTEMPT_CONFLICT');
  const reserved = reserveRunTasks(run, 0, [attemptIdentity], 0);
  expect(() => observeRunAttempt(reserved, 1, createAttempt({ ...attemptIdentity, generation: 2 }))).toThrow('RUN_ATTEMPT_CONFLICT');
  const started = applyAttemptObservation(createAttempt(attemptIdentity), { protocolVersion: 1, identity: attemptIdentity, sequence: 1, eventId: 'started', result: { kind: 'started' } }, 0);
  const observed = observeRunAttempt(reserved, 1, started);
  expect(() => observeRunAttempt(observed, 2, started)).toThrow('RUN_OBSERVATION_STALE');
  expect(() => runSnapshotSchema.parse({ ...reserved, bindings: [] })).toThrow();
  expect(() => runSnapshotSchema.parse({ ...reserved, bindings: [{ identity: attemptIdentity, observedRevision: 0, observedKind: 'started' }] })).toThrow();
});
it('records cancellation intent without inventing stopped workers or terminal task outcomes', () => {
  const reserved = reserveRunTasks(createRun(identity, graph, 0), 0, [attemptIdentity], 0);
  const cancelled = requestRunCancellation(reserved, 1);
  expect(cancelled.cancelRequested).toBe(true); expect(cancelled.progress[0]!.phase).toBe('active');
  expect(requestRunCancellation(cancelled, 2).revision).toBe(2);
  expect(() => reserveRunTasks(cancelled, 2, [{ ...attemptIdentity, taskId: 'b', attemptId: 'b' }], 0)).toThrow('RUN_CANCEL_REQUESTED');
  const stopped = applyAttemptObservation(createAttempt(attemptIdentity), { protocolVersion: 1, identity: attemptIdentity, sequence: 1, eventId: 'stopped', result: { kind: 'cancelled' } }, 0);
  expect(observeRunAttempt(cancelled, 2, stopped).progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
});
