import { describe, expect, it } from 'vitest';
import { createAttempt, applyAttemptObservation, requestAttemptCancellation, attemptPhase, AttemptError } from '#domain/index.js';

const identity = { runId: 'r1', taskId: 't1', attemptId: 'a1', scopeId: 'customer', layoutRevision: 'layout-v1', generation: 1 };
const event = (sequence: number, result: object = { kind: 'started' }, eventId = `event-${sequence}`) =>
  ({ protocolVersion: 1, identity, sequence, eventId, result });
const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (error) { expect(error).toBeInstanceOf(AttemptError); return (error as AttemptError).code; }
  return undefined;
};

describe('attempt reducer edges', () => {
  it('createAttempt starts reserved at revision 0 and refuses malformed identities', () => {
    const fresh = createAttempt(identity);
    expect(fresh).toMatchObject({ schemaVersion: 1, revision: 0, cancelRequested: false, lastObservation: null });
    expect(attemptPhase(fresh)).toBe('reserved');
    for (const bad of [null, undefined, 'x', { ...identity, generation: 0 }, { ...identity, runId: '' },
      { ...identity, extra: 1 }, { ...identity, generation: 1.5 }, { runId: 'r1' }]) {
      expect(code(() => createAttempt(bad))).toBe('ATTEMPT_INVALID');
    }
  });
  it('requestAttemptCancellation bumps revision once and is idempotent afterwards', () => {
    const fresh = createAttempt(identity);
    const requested = requestAttemptCancellation(fresh, 0);
    expect(requested).toMatchObject({ revision: 1, cancelRequested: true });
    expect(fresh.cancelRequested).toBe(false);
    // Already requested: equal snapshot, no revision bump (even though expected revision matches).
    expect(requestAttemptCancellation(requested, 1)).toEqual(requested);
  });
  it('requestAttemptCancellation checks revision and input before acting', () => {
    const fresh = createAttempt(identity);
    expect(code(() => requestAttemptCancellation(fresh, 1))).toBe('ATTEMPT_REVISION_CONFLICT');
    expect(code(() => requestAttemptCancellation({ ...fresh, revision: -1 }, 0))).toBe('ATTEMPT_INVALID');
    expect(code(() => requestAttemptCancellation({ ...fresh, extra: true }, 0))).toBe('ATTEMPT_INVALID');
    // A stale expected revision is refused even when the attempt is already finished.
    const finished = applyAttemptObservation(fresh, event(1, { kind: 'cancelled' }), 0);
    expect(code(() => requestAttemptCancellation(finished, 0))).toBe('ATTEMPT_REVISION_CONFLICT');
  });
  it('cancellation request on an unknown hold records intent without changing the phase', () => {
    const unknown = applyAttemptObservation(createAttempt(identity), event(1, { kind: 'unknown', reasonCode: 'LOST' }), 0);
    const requested = requestAttemptCancellation(unknown, 1);
    expect(requested.cancelRequested).toBe(true);
    expect(attemptPhase(requested)).toBe('unknown');
    expect(requested.lastObservation).toEqual(unknown.lastObservation);
  });
  it('refuses a second start and a terminal after a terminal, but accepts exit as first observation', () => {
    const started = applyAttemptObservation(createAttempt(identity), event(1), 0);
    expect(code(() => applyAttemptObservation(started, event(2), 1))).toBe('ATTEMPT_TRANSITION_INVALID');
    const exited = applyAttemptObservation(started, event(2, { kind: 'exited', exitCode: 3 }), 1);
    expect(exited.revision).toBe(2);
    expect(code(() => applyAttemptObservation(exited, event(3, { kind: 'unknown', reasonCode: 'X' }), 2))).toBe('ATTEMPT_TRANSITION_INVALID');
    const direct = applyAttemptObservation(createAttempt(identity), event(1, { kind: 'exited', exitCode: 0 }), 0);
    expect(attemptPhase(direct)).toBe('finished');
  });
  it('rejects a reused eventId on the next sequence and a differing replay of the same sequence', () => {
    const started = applyAttemptObservation(createAttempt(identity), event(1), 0);
    expect(code(() => applyAttemptObservation(started, event(2, { kind: 'exited', exitCode: 0 }, 'event-1'), 1)))
      .toBe('ATTEMPT_OBSERVATION_CONFLICT');
    expect(code(() => applyAttemptObservation(started, event(1, { kind: 'started' }, 'other-id'), 1)))
      .toBe('ATTEMPT_OBSERVATION_CONFLICT');
  });
  it('classifies older sequences as stale and flags gaps after the first observation', () => {
    const unknown = applyAttemptObservation(createAttempt(identity), event(1, { kind: 'unknown', reasonCode: 'L' }), 0);
    const second = applyAttemptObservation(unknown, event(2, { kind: 'exited', exitCode: 0 }), 1);
    expect(code(() => applyAttemptObservation(second, event(1, { kind: 'unknown', reasonCode: 'L' }), 2))).toBe('ATTEMPT_OBSERVATION_STALE');
    expect(code(() => applyAttemptObservation(unknown, event(3, { kind: 'exited', exitCode: 0 }), 1))).toBe('ATTEMPT_SEQUENCE_GAP');
  });
  it('refuses invalid observations with ATTEMPT_INVALID before any state-dependent check', () => {
    const fresh = createAttempt(identity);
    const bad: unknown[] = [
      event(0), { ...event(1), protocolVersion: 2 }, { ...event(1), eventId: '' }, { ...event(1), extra: 1 },
      event(1, { kind: 'exited', exitCode: null }), event(1, { kind: 'exited', exitCode: 0, signal: 'SIGTERM' }),
      event(1, { kind: 'exited' }), event(1, { kind: 'unknown' }), event(1, { kind: 'bogus' }), null,
    ];
    for (const observation of bad) {
      // Wrong revision proves validation runs first (ordering: validation, identity, revision).
      expect(code(() => applyAttemptObservation(fresh, observation, 99))).toBe('ATTEMPT_INVALID');
    }
    expect(code(() => applyAttemptObservation({ ...fresh, revision: 'x' }, event(1), 0))).toBe('ATTEMPT_INVALID');
  });
  it('checks identity before revision and never mutates its input snapshot', () => {
    const fresh = createAttempt(identity);
    const foreign = { ...event(1), identity: { ...identity, attemptId: 'a2' } };
    expect(code(() => applyAttemptObservation(fresh, foreign, 99))).toBe('ATTEMPT_IDENTITY_MISMATCH');
    const next = applyAttemptObservation(fresh, event(1), 0);
    expect(next).not.toBe(fresh);
    expect(fresh).toMatchObject({ revision: 0, lastObservation: null });
    expect(Object.isFrozen(next)).toBe(true);
  });
});
