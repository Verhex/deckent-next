export { ATTEMPT_PROTOCOL_VERSION, attemptIdentitySchema, attemptObservationSchema, attemptSnapshotSchema, sameAttemptIdentity, AttemptError, ENVIRONMENT_NOT_READY_CODE, ENVIRONMENT_UNCERTAIN_CODE } from './internal/contract.js';
export type { AttemptIdentity, AttemptObservation, AttemptSnapshot, AttemptPhase, AttemptErrorCode } from './internal/contract.js';
export { createAttempt, attemptPhase, requestAttemptCancellation, applyAttemptObservation } from './internal/reduce.js';
export { processExitCauseShape, processExitCauseSchema, isValidExitCause } from './internal/contract.js';
export type { ProcessExitCause } from './internal/contract.js';
export { decideDispatchLoss } from './internal/dispatch-loss.js';
export type { WorkerIncarnation, DispatchLossRecord, DispatchFence, DispatchTerminationProof, LostDispatchAction, DispatchLossDecision } from './internal/dispatch-loss.js';
