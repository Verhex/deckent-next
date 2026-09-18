import { expect, it } from 'vitest';
import {
  applyAttemptObservation, createAttempt, createRun, preventRunAttempt, requestAttemptCancellation, requestRunCancellation,
  reserveRunTasks, runSnapshotSchema, observeRunAttempt,
} from '#domain/index.js';

const identity = { runId: 'r', scopeId: 's', layoutRevision: 'layout' };
const graph = {
  schemaVersion: 2, revision: 1,
  tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify task result', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }],
};
const attemptIdentity = { ...identity, taskId: 'a', attemptId: 'attempt-a', generation: 1 };

function cancelledUnobserved() {
  const run = reserveRunTasks(createRun(identity, graph, 0), 0, [attemptIdentity], 0);
  const attempt = requestAttemptCancellation(createAttempt(attemptIdentity), 0);
  return { run, attempt };
}

it('prevents an unobserved bound attempt after cancellation without inventing observation evidence', () => {
  const { run, attempt } = cancelledUnobserved();
  const prevented = preventRunAttempt(run, 1, attempt);
  expect(prevented.progress[0]).toMatchObject({ taskId: 'a', phase: 'cancelled', unresolvedEffects: false });
  expect(prevented.bindings[0]).toMatchObject({ identity: attemptIdentity, observedRevision: null, observedKind: null });
  expect(prevented.cancelRequested).toBe(false);
  expect(prevented.revision).toBe(2);
});

it('makes repeated prevention idempotent for the same cancelled attempt', () => {
  const { run, attempt } = cancelledUnobserved();
  const first = preventRunAttempt(run, 1, attempt);
  const second = preventRunAttempt(first, 2, attempt);
  expect(second).toEqual(first);
});

it('rejects foreign identity, missing cancellation, observed attempts, and unresolved effects', () => {
  const { run, attempt } = cancelledUnobserved();
  expect(() => preventRunAttempt(run, 1, { ...attempt, identity: { ...attemptIdentity, scopeId: 'foreign' } }))
    .toThrow('RUN_ATTEMPT_CONFLICT');
  const reserved = reserveRunTasks(createRun(identity, graph, 0), 0, [attemptIdentity], 0);
  expect(() => preventRunAttempt(requestRunCancellation(reserved, 1), 2, createAttempt(attemptIdentity)))
    .toThrow('RUN_ATTEMPT_CONFLICT');

  const started = applyAttemptObservation(attempt, {
    protocolVersion: 1, identity: attemptIdentity, sequence: 1, eventId: 'started', result: { kind: 'started' },
  }, 1);
  const observed = observeRunAttempt(run, 1, started);
  expect(() => preventRunAttempt(observed, 2, started)).toThrow('RUN_ATTEMPT_CONFLICT');

  const unresolved = runSnapshotSchema.parse({ ...run,
    progress: run.progress.map(task => ({ ...task, unresolvedEffects: true })),
  });
  expect(() => preventRunAttempt(unresolved, 1, attempt)).toThrow('RUN_ATTEMPT_CONFLICT');
});
