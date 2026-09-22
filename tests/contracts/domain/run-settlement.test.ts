import { expect, it } from 'vitest';
import { applyAttemptObservation, applyTaskEvaluation, createAttempt, createRun, observeRunAttempt, requestAttemptCancellation,
  requestRunCancellation, reserveRunTasks, settleCancelledRunAttempt } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const identity = { runId: 'r', scopeId: 's', layoutRevision: 'layout' };
const graph = { schemaVersion: 2, revision: 1,
  tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify task result', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const attemptIdentity = { ...identity, taskId: 'a', attemptId: 'attempt-a', generation: 1 };
const exited = (exitCode: number) => ({ protocolVersion: 1, identity: attemptIdentity, sequence: 1, eventId: 'dispatch-terminal', result: { kind: 'exited', exitCode } });

function reserved() { return reserveRunTasks(createRun(identity, graph, 0, fixtureExecution(graph)), 0, [attemptIdentity], 0); }

it('settles a killed cancel-requested attempt whose exit is projected, idempotently', () => {
  const attempt = applyAttemptObservation(requestAttemptCancellation(createAttempt(attemptIdentity), 0), exited(137), 1);
  const observed = observeRunAttempt(requestRunCancellation(reserved(), 1), 2, attempt);
  expect(observed.progress[0]!.phase).toBe('evaluating');
  const settled = settleCancelledRunAttempt(observed, 3, attempt);
  expect(settled.progress[0]).toMatchObject({ taskId: 'a', phase: 'cancelled', unresolvedEffects: false });
  expect(settled.revision).toBe(4);
  expect(settleCancelledRunAttempt(settled, 4, attempt)).toEqual(settled);
});

it('settles an attempt that exited before the Run was cancelled without requiring attempt intent', () => {
  const attempt = applyAttemptObservation(createAttempt(attemptIdentity), exited(0), 0);
  const cancelled = requestRunCancellation(observeRunAttempt(reserved(), 1, attempt), 2);
  expect(settleCancelledRunAttempt(cancelled, 3, attempt).progress[0]!.phase).toBe('cancelled');
});

it('refuses settlement without cancellation intent, without projected exit, with unknown observation, unresolved effects or completed work', () => {
  const plain = applyAttemptObservation(createAttempt(attemptIdentity), exited(0), 0);
  const observedPlain = observeRunAttempt(reserved(), 1, plain);
  expect(() => settleCancelledRunAttempt(observedPlain, 2, plain)).toThrow('RUN_ATTEMPT_CONFLICT');
  const unobserved = requestAttemptCancellation(createAttempt(attemptIdentity), 0);
  expect(() => settleCancelledRunAttempt(requestRunCancellation(reserved(), 1), 2, unobserved)).toThrow('RUN_ATTEMPT_CONFLICT');
  const unknown = applyAttemptObservation(requestAttemptCancellation(createAttempt(attemptIdentity), 0),
    { protocolVersion: 1, identity: attemptIdentity, sequence: 1, eventId: 'lost', result: { kind: 'unknown', reasonCode: 'SUPERVISOR_OUTCOME_UNRESOLVED' } }, 1);
  const reconciling = observeRunAttempt(requestRunCancellation(reserved(), 1), 2, unknown);
  expect(reconciling.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  expect(() => settleCancelledRunAttempt(reconciling, 3, unknown)).toThrow('RUN_ATTEMPT_CONFLICT');
  const accepted = applyTaskEvaluation(observedPlain, 2, { schemaVersion: 1, evaluationId: 'eval', identity: attemptIdentity, graphRevision: 1, attemptRevision: 1,
    criteria: [{ criterionId: 'verified', verdict: 'pass', evidenceIds: ['dispatch-output'] }] }).snapshot;
  expect(accepted.progress[0]!.phase).toBe('accepted');
  expect(() => settleCancelledRunAttempt(requestRunCancellation(accepted, 3), 4, plain)).toThrow('RUN_ATTEMPT_CONFLICT');
  expect(() => settleCancelledRunAttempt(observedPlain, 2, { ...plain, identity: { ...attemptIdentity, scopeId: 'foreign' } })).toThrow();
});
