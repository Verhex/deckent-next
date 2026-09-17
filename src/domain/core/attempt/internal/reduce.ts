import { attemptIdentitySchema, attemptObservationSchema, attemptSnapshotSchema, ATTEMPT_PROTOCOL_VERSION,
  AttemptError, type AttemptSnapshot, type AttemptPhase } from './contract.js';

function snapshot(input: unknown): AttemptSnapshot {
  const parsed = attemptSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new AttemptError('ATTEMPT_INVALID');
  return parsed.data;
}
export function createAttempt(identity: unknown): AttemptSnapshot {
  const parsed = attemptIdentitySchema.safeParse(identity);
  if (!parsed.success) throw new AttemptError('ATTEMPT_INVALID');
  return snapshot({ schemaVersion: ATTEMPT_PROTOCOL_VERSION, identity: parsed.data, revision: 0,
    cancelRequested: false, lastObservation: null });
}
export function attemptPhase(state: AttemptSnapshot): AttemptPhase {
  switch (state.lastObservation?.result.kind) {
    case undefined: return 'reserved';
    case 'started': return 'running';
    case 'unknown': return 'unknown';
    case 'exited': case 'cancelled': return 'finished';
  }
}
function checkRevision(state: AttemptSnapshot, expectedRevision: number): void {
  if (state.revision !== expectedRevision) throw new AttemptError('ATTEMPT_REVISION_CONFLICT');
}
/** Pure application transition. Requesting cancellation proves neither process termination nor effect rollback. */
export function requestAttemptCancellation(input: unknown, expectedRevision: number): AttemptSnapshot {
  const state = snapshot(input);
  checkRevision(state, expectedRevision);
  if (state.cancelRequested || attemptPhase(state) === 'finished') return state;
  return snapshot({ ...state, revision: state.revision + 1, cancelRequested: true });
}
/** Supervisor evidence does not accept a Task. Persist this transition with CAS and an event journal at the application port. */
export function applyAttemptObservation(input: unknown, observationInput: unknown, expectedRevision: number): AttemptSnapshot {
  const state = snapshot(input);
  const parsed = attemptObservationSchema.safeParse(observationInput);
  if (!parsed.success) throw new AttemptError('ATTEMPT_INVALID');
  const observation = parsed.data;
  if (JSON.stringify(observation.identity) !== JSON.stringify(state.identity)) throw new AttemptError('ATTEMPT_IDENTITY_MISMATCH');
  checkRevision(state, expectedRevision);
  const previous = state.lastObservation;
  if (previous && observation.sequence <= previous.sequence) {
    if (JSON.stringify(previous) === JSON.stringify(observation)) return state;
    throw new AttemptError('ATTEMPT_OBSERVATION_CONFLICT');
  }
  if (observation.sequence !== (previous?.sequence ?? 0) + 1) throw new AttemptError('ATTEMPT_SEQUENCE_GAP');
  if (previous?.eventId === observation.eventId) throw new AttemptError('ATTEMPT_OBSERVATION_CONFLICT');
  const phase = attemptPhase(state);
  if (phase === 'finished' || (observation.result.kind === 'started' && phase !== 'reserved')) {
    throw new AttemptError('ATTEMPT_TRANSITION_INVALID');
  }
  // Exit/cancellation may be the first durable observation after process-start acknowledgement was lost.
  // Unknown is a reconciliation hold; only definitive later evidence can establish a terminal result.
  return snapshot({ ...state, revision: state.revision + 1, lastObservation: observation });
}
