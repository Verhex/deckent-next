import { expect, it } from 'vitest';
import { createAttempt, applyAttemptObservation, attemptPhase, createRun, reserveRunTasks, observeRunAttempt, reconcileRunLifecycle } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const identity = { runId: 'r', taskId: 'a', attemptId: 'a1', scopeId: 's', generation: 1, layoutRevision: 'l' };
const refusal = { protocolVersion: 1, identity, sequence: 1, eventId: 'handoff-failed', result: { kind: 'handoff-refused', code: 'HANDOFF_PATCH_UNAPPLICABLE' } };
const graph = { schemaVersion: 4, revision: 1, tasks: [
  { id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] },
  { id: 'b', kind: 'custom', dependencies: [{ taskId: 'a', startFrom: 'accepted-patch' }], acceptanceCriteria: ['verified'] },
], criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
it('records prelaunch typed refusal as a finished attempt without inventing process exit', () => {
  const refused = applyAttemptObservation(createAttempt(identity), refusal, 0);
  expect(attemptPhase(refused)).toBe('finished');
  expect(refused.lastObservation?.result).toEqual(refusal.result);
  expect(refused.lastObservation?.result).not.toHaveProperty('exitCode');
  expect(() => applyAttemptObservation(refused, { ...refusal, sequence: 2, eventId: 'start', result: { kind: 'started' } }, 1)).toThrow('ATTEMPT_TRANSITION_INVALID');
});
it('fails the task and propagates dependency closure from refusal before worker startup', () => {
  const runIdentity = { runId: 'r', scopeId: 's', layoutRevision: 'l' };
  const run = reserveRunTasks(createRun(runIdentity, graph, 1, fixtureExecution(graph)), 0, [identity], 1);
  const refused = applyAttemptObservation(createAttempt(identity), refusal, 0);
  const projected = observeRunAttempt(run, 1, refused);
  expect(projected.progress[0]).toMatchObject({ phase: 'failed', unresolvedEffects: false });
  expect(projected.bindings[0]).toMatchObject({ observedKind: 'handoff-refused' });
  const closed = reconcileRunLifecycle(projected, 1, 100);
  expect(closed.progress[1]).toMatchObject({ phase: 'skipped', skippedReason: 'dependency-failed' });
  expect(closed.state).toMatchObject({ kind: 'parked', reason: 'dependency-failed' });
});
it('rejects refusal after started or unknown execution and refuses arbitrary codes', () => {
  for (const result of [{ kind: 'started' }, { kind: 'unknown', reasonCode: 'UNCERTAIN' }]) {
    const attempt = applyAttemptObservation(createAttempt(identity), { ...refusal, eventId: 'prior', result }, 0);
    expect(() => applyAttemptObservation(attempt, { ...refusal, sequence: 2 }, 1)).toThrow('ATTEMPT_TRANSITION_INVALID');
  }
  expect(() => applyAttemptObservation(createAttempt(identity), { ...refusal, result: { kind: 'handoff-refused', code: 'ANY_ERROR' } }, 0)).toThrow('ATTEMPT_INVALID');
});
