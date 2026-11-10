export { ATTEMPT_PROTOCOL_VERSION, attemptIdentitySchema, attemptObservationSchema, attemptSnapshotSchema, sameAttemptIdentity, AttemptError, ENVIRONMENT_NOT_READY_CODE, ENVIRONMENT_UNCERTAIN_CODE, ENVIRONMENT_TIMED_OUT_CODE } from './internal/contract.js';
export type { AttemptIdentity, AttemptObservation, AttemptSnapshot, AttemptPhase, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AttemptErrorCode } from './internal/contract.js';
export { createAttempt, attemptPhase, requestAttemptCancellation, applyAttemptObservation } from './internal/reduce.js';
export { processExitCauseShape, processExitCauseSchema, isValidExitCause } from './internal/contract.js';
export type { ProcessExitCause } from './internal/contract.js';
export { decideDispatchLoss } from './internal/dispatch-loss.js';
export type { WorkerIncarnation, DispatchLossRecord, DispatchFence, DispatchTerminationProof, LostDispatchAction, DispatchLossDecision } from './internal/dispatch-loss.js';
export { workerIsolationSchema, workerIsolationProven } from './internal/isolation.js';
export type { WorkerIsolation } from './internal/isolation.js';
