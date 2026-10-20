import { z } from 'zod';
import { quotaExhaustedSchema } from '#domain/core/worker-event/index.js';
import { workerEffortSchema } from '#domain/core/provider-catalog/index.js';
import { identitySchema as identity, counterSchema as counter } from '#domain/core/primitives/index.js';

export const processExitCauseShape = { exitCode: z.number().int().safe().nullable(), signal: identity.optional() };
export function isValidExitCause(value: { exitCode: number | null; signal?: string | undefined }): boolean {
  return (value.exitCode === null) === (value.signal !== undefined);
}
export const processExitCauseSchema = z.object(processExitCauseShape).strict().refine(isValidExitCause, 'ATTEMPT_EXIT_CAUSE_INVALID');
export type ProcessExitCause = z.infer<typeof processExitCauseSchema>;

export const ATTEMPT_PROTOCOL_VERSION = 1;
/** PRE-7: the typed launch refusal of Deckent's own environment preflight; it alone names the unmet declared requirement. */
export const ENVIRONMENT_NOT_READY_CODE = 'EXECUTION_ENVIRONMENT_NOT_READY';
/** REVISE 2691: the preflight could not prove its probe container gone; nothing launched, the requirement's probe stays the owner. */
export const ENVIRONMENT_UNCERTAIN_CODE = 'EXECUTION_ENVIRONMENT_UNCERTAIN';
export const attemptIdentitySchema = z.object({
  runId: identity, taskId: identity, attemptId: identity,
  scopeId: identity, layoutRevision: identity, generation: counter.positive(),
}).strict().readonly();
export const attemptObservationSchema = z.object({
  protocolVersion: z.literal(ATTEMPT_PROTOCOL_VERSION),
  identity: attemptIdentitySchema,
  sequence: counter.positive(),
  eventId: identity,
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('started') }).strict(),
    z.object({ kind: z.literal('handoff-refused'), code: z.enum(['HANDOFF_PATCH_UNAPPLICABLE', 'HANDOFF_ARTIFACT_MISMATCH', 'HANDOFF_SOURCE_NOT_ACCEPTED', 'HANDOFF_LIMIT_EXCEEDED', 'HANDOFF_INVALID']) }).strict(),
    z.object({ kind: z.literal('quota-exhausted'), ...processExitCauseShape, quota: quotaExhaustedSchema, resetBoundExceeded: z.boolean().optional(), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ kind: z.literal('exited'), ...processExitCauseShape }).strict(),
    z.object({ kind: z.literal('cancelled') }).strict(),
    z.object({ kind: z.literal('unknown'), reasonCode: identity }).strict(),
    // Typed refusal before any dispatch claim (no launch, no effect); `code` is the refusing error code, open to adapter checks.
    // `requirement` (PRE-7) is the id of the unmet declared environment requirement, present exactly with ENVIRONMENT_NOT_READY_CODE.
    // REVISE 2693: `probe` names the container whose end the preflight could not prove; present exactly with ENVIRONMENT_UNCERTAIN_CODE.
    z.object({ kind: z.literal('launch-refused'), code: identity, requirement: identity.optional(), probe: identity.optional() }).strict(),
  ]).superRefine((result, context) => {
    if ((result.kind === 'exited' || result.kind === 'quota-exhausted') && !isValidExitCause(result)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'ATTEMPT_EXIT_CAUSE_INVALID' });
    }
    if (result.kind === 'launch-refused' && ((result.code === ENVIRONMENT_NOT_READY_CODE || result.code === ENVIRONMENT_UNCERTAIN_CODE) !== (result.requirement !== undefined)
      || (result.code === ENVIRONMENT_UNCERTAIN_CODE) !== (result.probe !== undefined))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'ATTEMPT_REFUSAL_INVALID' });
    }
  }).readonly(),
}).strict().readonly();
export const attemptSnapshotSchema = z.object({
  schemaVersion: z.literal(ATTEMPT_PROTOCOL_VERSION),
  identity: attemptIdentitySchema,
  revision: counter,
  reasoningEffort: workerEffortSchema.optional(),
  cancelRequested: z.boolean(),
  lastObservation: attemptObservationSchema.nullable(),
}).strict().superRefine((state, context) => {
  const observation = state.lastObservation;
  if (observation && (!sameAttemptIdentity(observation.identity, state.identity) || observation.sequence > state.revision)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'ATTEMPT_SNAPSHOT_INCONSISTENT' });
  }
}).readonly();
export type AttemptIdentity = z.infer<typeof attemptIdentitySchema>;
export type AttemptObservation = z.infer<typeof attemptObservationSchema>;
export type AttemptSnapshot = z.infer<typeof attemptSnapshotSchema>;
export type AttemptPhase = 'reserved' | 'running' | 'unknown' | 'finished';
export type AttemptErrorCode = 'ATTEMPT_INVALID' | 'ATTEMPT_IDENTITY_MISMATCH' | 'ATTEMPT_REVISION_CONFLICT'
  | 'ATTEMPT_OBSERVATION_STALE' | 'ATTEMPT_SEQUENCE_GAP' | 'ATTEMPT_OBSERVATION_CONFLICT' | 'ATTEMPT_TRANSITION_INVALID';
export class AttemptError extends Error {
  constructor(readonly code: AttemptErrorCode) { super(code); this.name = 'AttemptError'; }
}

export function sameAttemptIdentity(a: AttemptIdentity, b: AttemptIdentity): boolean {
  return a.runId === b.runId && a.taskId === b.taskId && a.attemptId === b.attemptId &&
    a.scopeId === b.scopeId && a.layoutRevision === b.layoutRevision && a.generation === b.generation;
}
