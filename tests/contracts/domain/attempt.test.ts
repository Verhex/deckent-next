import { describe, expect, it } from 'vitest';
import { createAttempt, applyAttemptObservation, requestAttemptCancellation, attemptPhase } from '../../../src/domain/index.js';

const identity = { runId: 'r1', taskId: 't1', attemptId: 'a1', scopeId: 'customer', layoutRevision: 'layout-v1', generation: 1 };
const event = (sequence: number, result: object = { kind: 'started' }) => ({ protocolVersion: 1, identity, sequence, eventId: `event-${sequence}`, result });

describe('attempt evidence application', () => {
  it('pins scope, layout and generation; process success is not Task acceptance', () => {
    const input = { ...identity };
    const reserved = createAttempt(input);
    input.layoutRevision = 'changed';
    const started = applyAttemptObservation(reserved, event(1), 0);
    const exited = applyAttemptObservation(started, event(2, { kind: 'exited', exitCode: 0 }), 1);
    expect(attemptPhase(exited)).toBe('finished');
    expect(exited.identity.layoutRevision).toBe('layout-v1');
    expect(exited).not.toHaveProperty('accepted');
    expect(Object.isFrozen(exited.identity)).toBe(true);
    expect(Object.isFrozen(exited.lastObservation!.result)).toBe(true);
  });
  it('rejects stale workers, foreign scopes, substituted task and layout identities', () => {
    for (const patch of [{ generation: 2 }, { scopeId: 'other' }, { taskId: 'other' }, { layoutRevision: 'other' }]) {
      expect(() => applyAttemptObservation(createAttempt(identity), { ...event(1), identity: { ...identity, ...patch } }, 0)).toThrow('ATTEMPT_IDENTITY_MISMATCH');
    }
  });
  it('keeps cancellation intent separate from observed termination and handles the start race', () => {
    const requested = requestAttemptCancellation(createAttempt(identity), 0);
    expect(attemptPhase(requested)).toBe('reserved');
    const started = applyAttemptObservation(requested, event(1), 1);
    expect(started.cancelRequested).toBe(true);
    expect(attemptPhase(started)).toBe('running');
    const cancelled = applyAttemptObservation(started, event(2, { kind: 'cancelled' }), 2);
    expect(attemptPhase(cancelled)).toBe('finished');
    expect(requestAttemptCancellation(cancelled, 3)).toEqual(cancelled);
  });
  it('holds unknown outcomes for reconciliation without inventing process failure', () => {
    const unknown = applyAttemptObservation(createAttempt(identity), event(1, { kind: 'unknown', reasonCode: 'CONNECTION_LOST' }), 0);
    expect(attemptPhase(unknown)).toBe('unknown');
    expect(() => applyAttemptObservation(unknown, event(2), 1)).toThrow('ATTEMPT_TRANSITION_INVALID');
    const reconciled = applyAttemptObservation(unknown, event(2, { kind: 'exited', exitCode: 0 }), 1);
    expect(attemptPhase(reconciled)).toBe('finished');
  });
  it('deduplicates latest exact evidence and rejects conflicting terminals, gaps and stale revisions', () => {
    const reserved = createAttempt(identity);
    const first = event(1, { kind: 'exited', exitCode: 0 });
    const exited = applyAttemptObservation(reserved, first, 0);
    expect(applyAttemptObservation(exited, first, 1)).toEqual(exited);
    expect(() => applyAttemptObservation(exited, event(1, { kind: 'exited', exitCode: 1 }), 1)).toThrow('ATTEMPT_OBSERVATION_CONFLICT');
    expect(() => applyAttemptObservation(exited, event(2, { kind: 'cancelled' }), 1)).toThrow('ATTEMPT_TRANSITION_INVALID');
    expect(() => applyAttemptObservation(reserved, event(2), 0)).toThrow('ATTEMPT_SEQUENCE_GAP');
    expect(() => applyAttemptObservation(reserved, event(1), 1)).toThrow('ATTEMPT_REVISION_CONFLICT');
  });
  it('rejects malformed protocol and contradictory persisted snapshot evidence', () => {
    const reserved = createAttempt(identity);
    expect(() => applyAttemptObservation(reserved, { ...event(1), protocolVersion: 2 }, 0)).toThrow('ATTEMPT_INVALID');
    expect(() => requestAttemptCancellation({ ...reserved, lastObservation: event(1) }, 0)).toThrow('ATTEMPT_INVALID');
    expect(() => applyAttemptObservation(reserved, event(1, { kind: 'exited', exitCode: 0, accepted: true }), 0)).toThrow('ATTEMPT_INVALID');
  });
});

describe('supervisor termination evidence', () => {
  it('records signal exits without inventing an exit code', () => {
    const state = applyAttemptObservation(createAttempt(identity), event(1, { kind: 'exited', exitCode: null, signal: 'SIGTERM' }), 0);
    expect(state.lastObservation!.result).toEqual({ kind: 'exited', exitCode: null, signal: 'SIGTERM' });
    expect(attemptPhase(state)).toBe('finished');
    for (const result of [{ kind: 'exited', exitCode: null }, { kind: 'exited', exitCode: 0, signal: 'SIGTERM' }]) {
      expect(() => applyAttemptObservation(createAttempt(identity), event(1, result), 0)).toThrow('ATTEMPT_INVALID');
    }
  });
  it('keeps externally observed cancellation separate from a user request', () => {
    const state = applyAttemptObservation(createAttempt(identity), event(1, { kind: 'cancelled' }), 0);
    expect(state.cancelRequested).toBe(false);
  });
  it('classifies older evidence as stale; only journal receipts can establish exact historical replay', () => {
    const started = applyAttemptObservation(createAttempt(identity), event(1), 0);
    const exited = applyAttemptObservation(started, event(2, { kind: 'exited', exitCode: 0 }), 1);
    expect(() => applyAttemptObservation(exited, event(1), 2)).toThrow('ATTEMPT_OBSERVATION_STALE');
  });
});
