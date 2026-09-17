import { z } from 'zod';
import { identitySchema as identity, counterSchema as counter } from '#domain/core/primitives/index.js';

export const ATTEMPT_PROTOCOL_VERSION = 1;
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
    z.object({ kind: z.literal('exited'), exitCode: z.number().int().safe().nullable(), signal: identity.optional() }).strict(),
    z.object({ kind: z.literal('cancelled') }).strict(),
    z.object({ kind: z.literal('unknown'), reasonCode: identity }).strict(),
  ]).superRefine((result, context) => {
    if (result.kind === 'exited' && ((result.exitCode === null) !== (result.signal !== undefined))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'ATTEMPT_EXIT_CAUSE_INVALID' });
    }
  }).readonly(),
}).strict().readonly();
export const attemptSnapshotSchema = z.object({
  schemaVersion: z.literal(ATTEMPT_PROTOCOL_VERSION),
  identity: attemptIdentitySchema,
  revision: counter,
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
