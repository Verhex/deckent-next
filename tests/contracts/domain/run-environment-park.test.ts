import { expect, it } from 'vitest';
import { createAttempt, applyAttemptObservation, createRun, reserveRunTasks, observeRunAttempt, observeRunAttemptClosure, resumeParkedRun, advanceRunLifecycle,
  closeParkedRun, holdRun, requestRunCancellation, runSnapshotSchema, environmentRequirementsSchema, ENVIRONMENT_NOT_READY_CODE } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
// PRE-7 ORTAM-HAZIR: a launch refused by Deckent's own preflight (an unmet declared environment requirement) parks the Run for the operator,
// keeps the task pending for a NEW attempt after an explicit resume, and never fails the work or offers acceptance.
const identity = { runId: 'r', taskId: 'a', attemptId: 'a1', scopeId: 's', generation: 1, layoutRevision: 'l' };
const observation = (sequence: number, result: unknown) => ({ protocolVersion: 1, identity, sequence, eventId: `e${sequence}`, result });
const graph = { schemaVersion: 4, revision: 1, tasks: [
  { id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] },
  { id: 'b', kind: 'custom', dependencies: ['a'], acceptanceCriteria: ['verified'] },
], criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const reserved = () => reserveRunTasks(createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 1, fixtureExecution(graph)), 0, [identity], 1);
const refused = (requirement?: string) => applyAttemptObservation(createAttempt(identity), observation(1, { kind: 'launch-refused', code: requirement ? ENVIRONMENT_NOT_READY_CODE : 'EXECUTION_NOT_CONFIGURED', ...(requirement ? { requirement } : {}) }), 0);
const timing = { now: 10, timeoutMs: 100 };

it('an unmet environment requirement parks the Run naming it; the task stays pending, its dependents wait, nothing fails', () => {
  const parked = observeRunAttemptClosure(reserved(), 1, refused('typescript'), timing.now, timing.timeoutMs);
  expect(parked.state).toEqual({ kind: 'parked', reason: 'environment-not-ready', failureCode: 'typescript', since: 10, deadline: 110 });
  expect(parked.progress.map(task => [task.phase, task.notAcceptedReason])).toEqual([['pending', undefined], ['pending', undefined]]);
  expect(parked.bindings[0]).toMatchObject({ observedKind: 'launch-refused' });
  // The ledger's own advance never reserves or revives it: the park holds until the operator acts or the bound expires.
  expect(advanceRunLifecycle(parked, parked.revision, 50, timing.timeoutMs)).toEqual(parked);
  expect(() => reserveRunTasks(parked, parked.revision, [{ ...identity, attemptId: 'a2', generation: 2 }], 50)).toThrow('RUN_PARKED');
});

it('resume after the fix moves the refused attempt aside so a new generation starts (its preflight runs again); no blind retry', () => {
  const parked = observeRunAttemptClosure(reserved(), 1, refused('typescript'), timing.now, timing.timeoutMs);
  const resumed = resumeParkedRun(parked, parked.revision, 20, timing.timeoutMs);
  expect(resumed.state).toEqual({ kind: 'running' }); expect(resumed.bindings).toEqual([]);
  expect(resumed.previousBindings).toEqual([expect.objectContaining({ observedKind: 'launch-refused', identity })]);
  const next = reserveRunTasks(resumed, resumed.revision, [{ ...identity, attemptId: 'a2', generation: 2 }], 20);
  expect(next.progress[0]!.phase).toBe('active');
  expect(() => reserveRunTasks(resumed, resumed.revision, [{ ...identity, attemptId: 'a1', generation: 2 }], 20)).toThrow('RUN_ATTEMPT_CONFLICT');
});

it('the park is time-bounded: past its deadline the Run ends park-timeout; close and cancel end it without failing the work', () => {
  const parked = observeRunAttemptClosure(reserved(), 1, refused('typescript'), timing.now, timing.timeoutMs);
  const expired = advanceRunLifecycle(parked, parked.revision, 110, timing.timeoutMs);
  expect(expired.state).toEqual({ kind: 'terminal', outcome: 'failed', reason: 'park-timeout' });
  expect(expired.progress.map(task => task.phase)).toEqual(['cancelled', 'cancelled']);
  expect(closeParkedRun(parked, parked.revision, 20, timing.timeoutMs).state).toEqual({ kind: 'terminal', outcome: 'failed', reason: 'operator-close' });
  const cancelled = requestRunCancellation(parked, parked.revision, { now: 20, timeoutMs: timing.timeoutMs });
  expect(cancelled.state).toMatchObject({ kind: 'terminal', reason: 'cancelled' }); expect(cancelled.progress[0]!.phase).toBe('cancelled');
});

it('an operator hold survives the environment park and is released first; the environment park stays until its own resume', () => {
  const held = holdRun(reserved(), 1, 'maintenance', 5, timing.timeoutMs);
  const parked = observeRunAttemptClosure(held, held.revision, refused('node'), timing.now, timing.timeoutMs);
  expect(parked.state).toMatchObject({ kind: 'parked', reason: 'environment-not-ready', failureCode: 'node', operatorHold: { schemaVersion: 1, note: 'maintenance' } });
  const released = resumeParkedRun(parked, parked.revision, 20, timing.timeoutMs);
  expect(released.state).toEqual({ kind: 'parked', reason: 'environment-not-ready', failureCode: 'node', since: 10, deadline: 110 });
});

it('negative: any other launch refusal still fails its task; a refusal without evidence cannot park; the stored shape stays consistent', () => {
  const failed = observeRunAttemptClosure(reserved(), 1, refused(), timing.now, timing.timeoutMs);
  expect(failed.progress[0]!.phase).toBe('failed'); expect(failed.state).toMatchObject({ kind: 'parked', reason: 'dependency-failed' });
  // observeRunAttempt alone never parks for the environment (the timed transition owns it).
  expect(() => observeRunAttempt(reserved(), 1, refused('typescript'))).toThrow('RUN_ATTEMPT_CONFLICT');
  const parked = observeRunAttemptClosure(reserved(), 1, refused('typescript'), timing.now, timing.timeoutMs);
  expect(() => runSnapshotSchema.parse({ ...parked, bindings: [{ ...parked.bindings[0]!, observedKind: null, observedRevision: null }] })).toThrow();
  expect(() => runSnapshotSchema.parse({ ...parked, state: { ...parked.state, failureCode: undefined } })).toThrow();
  expect(() => applyAttemptObservation(createAttempt(identity), observation(1, { kind: 'launch-refused', code: 'EXECUTION_NOT_CONFIGURED', requirement: 'node' }), 0)).toThrow('ATTEMPT_INVALID');
  // A cancelled Run does not park: the refusal fails the task as before.
  const cancelling = requestRunCancellation(reserved(), 1, { now: 5, timeoutMs: timing.timeoutMs });
  expect(observeRunAttemptClosure(cancelling, cancelling.revision, refused('typescript'), timing.now, timing.timeoutMs).progress[0]!.phase).toBe('failed');
});

it('declared requirements are versioned registry data in the generic form kind + target (+ expectation), unique ids, bounded', () => {
  const ok = { schemaVersion: 1, requirements: [{ id: 'node', kind: 'executable', target: 'node' }, { id: 'heap', kind: 'node-heap', target: 'node', expect: '1610612736' }] };
  expect(environmentRequirementsSchema.parse(ok)).toEqual(ok);
  for (const bad of [{ ...ok, schemaVersion: 2 }, { ...ok, requirements: [] }, { ...ok, requirements: [ok.requirements[0], ok.requirements[0]] },
    { ...ok, requirements: [{ id: 'x', kind: 'executable', target: 'a\0b' }] }, { ...ok, requirements: [{ id: 'x', kind: 'executable', target: 'node', argv: ['sh'] }] }]) {
    expect(environmentRequirementsSchema.safeParse(bad).success).toBe(false);
  }
});
