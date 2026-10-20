import { expect, it } from 'vitest';
import { createAttempt, applyAttemptObservation, createRun, reserveRunTasks, observeRunAttempt, observeRunAttemptClosure, resumeParkedRun, advanceRunLifecycle,
  closeParkedRun, holdRun, requestRunCancellation, runSnapshotSchema, settleEnvironmentProbe, environmentRequirementsSchema, ENVIRONMENT_NOT_READY_CODE, ENVIRONMENT_UNCERTAIN_CODE,
  holdEnvironmentProbes, releaseEnvironmentProbes, preventRunAttempt, requestAttemptCancellation } from '#domain/index.js';
import { measureTaskOccupancy } from '#engine/index.js';
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

it('REVISE 2691: an uncertain probe end is a typed launch refusal with its requirement and probe; without them it is invalid', () => {
  expect(() => applyAttemptObservation(createAttempt(identity), observation(1, { kind: 'launch-refused', code: ENVIRONMENT_UNCERTAIN_CODE, requirement: 'node' }), 0)).toThrow('ATTEMPT_INVALID');
  expect(() => applyAttemptObservation(createAttempt(identity), observation(1, { kind: 'launch-refused', code: ENVIRONMENT_NOT_READY_CODE, requirement: 'node', probe: 'deckent-env-x' }), 0)).toThrow('ATTEMPT_INVALID');
});

// REVISE 2693: until the probe's end is proven the task keeps its slot as an unresolved effect; nothing — another Run's reservation,
// cancel, deadline, close or resume — releases it; only the proven settlement does, exactly once.
const uncertainAttempt = () => applyAttemptObservation(createAttempt(identity), observation(1, { kind: 'launch-refused', code: ENVIRONMENT_UNCERTAIN_CODE, requirement: 'node', probe: 'deckent-env-x' }), 0);
const uncertainPark = () => observeRunAttemptClosure(reserved(), 1, uncertainAttempt(), timing.now, timing.timeoutMs);
it('REVISE 2693: an uncertain probe parks the Run and keeps the slot occupied (unresolved effect)', () => {
  const parked = uncertainPark();
  expect(parked.state).toEqual({ kind: 'parked', reason: 'environment-not-ready', failureCode: 'node', since: 10, deadline: 110 });
  expect(parked.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: true });
  expect(measureTaskOccupancy(parked.progress)).toEqual({ execution: 1, inFlight: 1 });
});
it('REVISE 2693: cancel, deadline, close and resume cannot release an uncertain probe', () => {
  const parked = uncertainPark();
  const cancelled = requestRunCancellation(parked, parked.revision, { now: 20, timeoutMs: timing.timeoutMs });
  expect(cancelled.state.kind).not.toBe('terminal'); expect(cancelled.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: true });
  expect(measureTaskOccupancy(cancelled.progress).execution).toBe(1);
  const expired = advanceRunLifecycle(parked, parked.revision, 500, timing.timeoutMs);
  expect(expired.state.kind).toBe('parked'); expect(expired.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: true });
  expect(() => closeParkedRun(parked, parked.revision, 20, timing.timeoutMs)).toThrow('RUN_DECISION_NOT_READY');
  expect(() => resumeParkedRun(parked, parked.revision, 20, timing.timeoutMs)).toThrow('RUN_DECISION_NOT_READY');
});
it('REVISE 2693: the proven settlement releases the slot exactly once; then resume or a pending cancel proceeds', () => {
  const parked = uncertainPark(), settled = settleEnvironmentProbe(parked, parked.revision, identity, 20, timing.timeoutMs);
  expect(settled.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: false }); expect(settled.state).toMatchObject({ kind: 'parked', reason: 'environment-not-ready' });
  expect(measureTaskOccupancy(settled.progress)).toEqual({ execution: 0, inFlight: 0 });
  expect(() => settleEnvironmentProbe(settled, settled.revision, identity, 20, timing.timeoutMs)).toThrow('RUN_ATTEMPT_CONFLICT');
  expect(resumeParkedRun(settled, settled.revision, 30, timing.timeoutMs).state).toEqual({ kind: 'running' });
  // A non-uncertain environment park has nothing to settle.
  const plain = observeRunAttemptClosure(reserved(), 1, refused('typescript'), timing.now, timing.timeoutMs);
  expect(() => settleEnvironmentProbe(plain, plain.revision, identity, 20, timing.timeoutMs)).toThrow('RUN_ATTEMPT_CONFLICT');
  // Cancel requested while uncertain: the settlement closes the held task, and the Run ends.
  const cancelling = requestRunCancellation(parked, parked.revision, { now: 20, timeoutMs: timing.timeoutMs });
  const ended = settleEnvironmentProbe(cancelling, cancelling.revision, identity, 30, timing.timeoutMs);
  expect(ended.state).toMatchObject({ kind: 'terminal', reason: 'cancelled' }); expect(ended.progress[0]!.phase).toBe('cancelled');
});
it('REVISE 2693: an uncertain probe on an already cancelled Run still holds the slot', () => {
  const cancelling = requestRunCancellation(reserved(), 1, { now: 5, timeoutMs: timing.timeoutMs });
  const held = observeRunAttemptClosure(cancelling, cancelling.revision, uncertainAttempt(), timing.now, timing.timeoutMs);
  expect(held.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: true }); expect(held.state.kind).not.toBe('terminal');
});

// REVISE 2695: custody is written before the first probe container can start; only the end of the probe path (an answer, or a proven
// removal) transitions it, exactly once. Cancellation (Run or attempt), prevention and a worker observation never release it.
const PROBES = ['deckent-env-' + 'b'.repeat(64), 'deckent-env-' + 'c'.repeat(64)];
const custody = (run = reserved()) => holdEnvironmentProbes(run, run.revision, identity, PROBES);
it('REVISE 2695: custody before the probe keeps the slot; cancel cannot settle, prevent or close it; nothing else may observe the attempt', () => {
  const held = custody();
  expect(held.progress[0]).toMatchObject({ phase: 'active', unresolvedEffects: true }); expect(held.bindings[0]).toMatchObject({ observedKind: null, probes: PROBES });
  expect(measureTaskOccupancy(held.progress)).toEqual({ execution: 1, inFlight: 1 });
  const cancelling = requestRunCancellation(held, held.revision, timing);
  expect(cancelling.progress[0]).toMatchObject({ phase: 'active', unresolvedEffects: true }); expect(cancelling.state.kind).not.toBe('terminal');
  expect(measureTaskOccupancy(cancelling.progress).execution).toBe(1);
  expect(() => preventRunAttempt(cancelling, cancelling.revision, requestAttemptCancellation(createAttempt(identity), 0), timing)).toThrow('RUN_ATTEMPT_CONFLICT');
  expect(() => observeRunAttempt(held, held.revision, applyAttemptObservation(createAttempt(identity), observation(1, { kind: 'started' }), 0))).toThrow('RUN_ATTEMPT_CONFLICT');
  expect(() => observeRunAttemptClosure(held, held.revision, refused(), timing.now, timing.timeoutMs)).toThrow('RUN_ATTEMPT_CONFLICT');
  expect(() => custody(held)).toThrow('RUN_ATTEMPT_CONFLICT');
  const cancelled = requestRunCancellation(reserved(), 1, timing);
  expect(() => custody(cancelled)).toThrow('RUN_CANCEL_REQUESTED');
  // The stored shape: names exactly with an active task under an unresolved effect and an unobserved binding.
  expect(() => runSnapshotSchema.parse({ ...held, progress: [{ ...held.progress[0]!, unresolvedEffects: false }, held.progress[1]] })).toThrow();
  expect(() => runSnapshotSchema.parse({ ...held, bindings: [{ ...held.bindings[0]!, probes: ['x'.repeat(300)] }] })).toThrow();
});
it('REVISE 2695: met — the release clears the custody once; with cancel requested (Run or attempt) it closes the task cancelled in the same step', () => {
  const held = custody(), released = releaseEnvironmentProbes(held, held.revision, createAttempt(identity), timing.now, timing.timeoutMs);
  expect(released.progress[0]).toMatchObject({ phase: 'active', unresolvedEffects: false }); expect(released.bindings[0]).not.toHaveProperty('probes');
  expect(() => releaseEnvironmentProbes(released, released.revision, createAttempt(identity), timing.now, timing.timeoutMs)).toThrow('RUN_ATTEMPT_CONFLICT');
  const cancelling = requestRunCancellation(held, held.revision, timing);
  const ended = releaseEnvironmentProbes(cancelling, cancelling.revision, requestAttemptCancellation(createAttempt(identity), 0), timing.now, timing.timeoutMs);
  expect(ended.progress.map(task => task.phase)).toEqual(['cancelled', 'cancelled']); expect(ended.state).toMatchObject({ kind: 'terminal', reason: 'cancelled' });
  expect(measureTaskOccupancy(ended.progress)).toEqual({ execution: 0, inFlight: 0 });
  const attemptOnly = releaseEnvironmentProbes(held, held.revision, requestAttemptCancellation(createAttempt(identity), 0), timing.now, timing.timeoutMs);
  expect(attemptOnly.progress[0]).toMatchObject({ phase: 'cancelled', unresolvedEffects: false });
});
it('REVISE 2695: an environment answer transitions from custody: unmet parks, unmet under cancel fails as before, uncertain becomes the 2693 hold', () => {
  const parked = observeRunAttemptClosure(custody(), 2, refused('typescript'), timing.now, timing.timeoutMs);
  expect(parked.state).toMatchObject({ kind: 'parked', reason: 'environment-not-ready', failureCode: 'typescript' });
  expect(parked.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: false }); expect(parked.bindings[0]).not.toHaveProperty('probes');
  const cancelling = requestRunCancellation(custody(), 2, timing);
  expect(observeRunAttemptClosure(cancelling, cancelling.revision, refused('typescript'), timing.now, timing.timeoutMs).progress[0]).toMatchObject({ phase: 'failed', unresolvedEffects: false });
  for (const run of [custody(), cancelling]) {
    const held = observeRunAttemptClosure(run, run.revision, uncertainAttempt(), timing.now, timing.timeoutMs);
    expect(held.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: true }); expect(held.bindings[0]).toMatchObject({ observedKind: 'launch-refused' });
    expect(held.bindings[0]).not.toHaveProperty('probes'); expect(measureTaskOccupancy(held.progress).execution).toBe(1);
  }
  // A crash between the attempt's recorded answer and its Run projection: the release completes that projection instead.
  expect(releaseEnvironmentProbes(custody(), 2, refused('typescript'), timing.now, timing.timeoutMs).state).toMatchObject({ reason: 'environment-not-ready' });
});

it('declared requirements are versioned registry data in the generic form kind + target (+ expectation), unique ids, bounded', () => {
  const ok = { schemaVersion: 1, requirements: [{ id: 'node', kind: 'executable', target: 'node' }, { id: 'heap', kind: 'node-heap', target: 'node', expect: '1610612736' }] };
  expect(environmentRequirementsSchema.parse(ok)).toEqual(ok);
  for (const bad of [{ ...ok, schemaVersion: 2 }, { ...ok, requirements: [] }, { ...ok, requirements: [ok.requirements[0], ok.requirements[0]] },
    { ...ok, requirements: [{ id: 'x', kind: 'executable', target: 'a\0b' }] }, { ...ok, requirements: [{ id: 'x', kind: 'executable', target: 'node', argv: ['sh'] }] }]) {
    expect(environmentRequirementsSchema.safeParse(bad).success).toBe(false);
  }
});
