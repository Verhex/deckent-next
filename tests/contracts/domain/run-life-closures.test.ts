import { expect, it } from 'vitest';
import { createAttempt, applyAttemptObservation, attemptPhase, createRun, reserveRunTasks, observeRunAttempt, reconcileRunLifecycle, closesAttemptWithoutExit } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const identity = { runId: 'r', taskId: 'a', attemptId: 'a1', scopeId: 's', generation: 1, layoutRevision: 'l' };
const observation = (sequence: number, result: unknown) => ({ protocolVersion: 1, identity, sequence, eventId: `e${sequence}`, result });
const graph = { schemaVersion: 4, revision: 1, tasks: [
  { id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] },
  { id: 'b', kind: 'custom', dependencies: ['a'], acceptanceCriteria: ['verified'] },
], criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const reserved = () => reserveRunTasks(createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 1, fixtureExecution(graph)), 0, [identity], 1);

it('launch-refused is a finished pre-launch attempt that fails its task and closes dependents, never an exit', () => {
  const refused = applyAttemptObservation(createAttempt(identity), observation(1, { kind: 'launch-refused', code: 'EXECUTION_NOT_CONFIGURED' }), 0);
  expect(attemptPhase(refused)).toBe('finished'); expect(refused.lastObservation?.result).not.toHaveProperty('exitCode');
  const projected = observeRunAttempt(reserved(), 1, refused);
  expect(projected.progress[0]).toMatchObject({ phase: 'failed', unresolvedEffects: false }); expect(projected.bindings[0]).toMatchObject({ observedKind: 'launch-refused' });
  expect(reconcileRunLifecycle(projected, 1, 100).progress[1]).toMatchObject({ phase: 'skipped', skippedReason: 'dependency-failed' });
  expect(() => applyAttemptObservation(refused, observation(2, { kind: 'started' }), 1)).toThrow('ATTEMPT_TRANSITION_INVALID');
  expect(closesAttemptWithoutExit('launch-refused') && closesAttemptWithoutExit('handoff-refused')).toBe(true);
  expect([closesAttemptWithoutExit('unknown'), closesAttemptWithoutExit('exited'), closesAttemptWithoutExit(null)]).toEqual([false, false, false]);
});

it('launch-refused cannot follow any observation: a started or unknown attempt is not refusable', () => {
  for (const result of [{ kind: 'started' }, { kind: 'unknown', reasonCode: 'UNCERTAIN' }]) {
    const attempt = applyAttemptObservation(createAttempt(identity), observation(1, result), 0);
    expect(() => applyAttemptObservation(attempt, observation(2, { kind: 'launch-refused', code: 'EXECUTION_NOT_CONFIGURED' }), 1)).toThrow('ATTEMPT_TRANSITION_INVALID');
  }
});

it('a lost worker is an unknown outcome: the task is held in reconciliation with unresolved effects, never failed, and later exit cannot clear it', () => {
  for (const prior of [[], [{ kind: 'started' }]]) {
    let attempt = createAttempt(identity), run = reserved();
    for (const result of prior) { attempt = applyAttemptObservation(attempt, observation(attempt.revision + 1, result), attempt.revision); run = observeRunAttempt(run, run.revision, attempt); }
    attempt = applyAttemptObservation(attempt, observation(attempt.revision + 1, { kind: 'unknown', reasonCode: 'WORKER_LOST' }), attempt.revision);
    expect(attemptPhase(attempt)).toBe('unknown');
    run = observeRunAttempt(run, run.revision, attempt);
    expect(run.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true }); expect(run.bindings[0]).toMatchObject({ observedKind: 'unknown' });
    // A resumed executor's exit is still recorded, but the uncertain hold stays: no acceptance, no failure, no freed slot.
    attempt = applyAttemptObservation(attempt, observation(attempt.revision + 1, { kind: 'exited', exitCode: 0 }), attempt.revision);
    expect(observeRunAttempt(run, run.revision, attempt).progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  }
});

it('negative: the attempt and Run vocabularies have no closing kind for a launched attempt, and refusals cannot follow an unknown outcome', () => {
  expect(() => applyAttemptObservation(createAttempt(identity), observation(1, { kind: 'abandoned' }), 0)).toThrow('ATTEMPT_INVALID');
  expect(closesAttemptWithoutExit('abandoned')).toBe(false);
  const unknown = applyAttemptObservation(createAttempt(identity), observation(1, { kind: 'unknown', reasonCode: 'WORKER_LOST' }), 0);
  const held = observeRunAttempt(reserved(), 1, unknown);
  // Even a forged refusal snapshot cannot close a task whose effects are unresolved.
  const forged = applyAttemptObservation(createAttempt(identity), observation(1, { kind: 'launch-refused', code: 'EXECUTION_NOT_CONFIGURED' }), 0);
  expect(() => observeRunAttempt(held, held.revision, { ...forged, revision: 2, lastObservation: { ...forged.lastObservation!, sequence: 2 } })).toThrow('RUN_ATTEMPT_CONFLICT');
});
