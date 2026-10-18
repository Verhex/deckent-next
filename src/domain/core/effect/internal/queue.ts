import { z } from 'zod';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
import { counterSchema, identitySchema, clientCommandIdSchema } from '#domain/core/primitives/index.js';
import { targetBindingSchema, candidateBindingSchema, candidateEvidenceSchema } from './candidate.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** A typed error code (never a message or an arbitrary error text). */
export const queueReasonSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
const actor = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly();
type QueueActor = z.infer<typeof actor>;
/** D2b (owner 2026-10-18): a human's explicit per-Run delivery intent, set only on that human's own enqueue (one Run = identity.runId, one
 * target = target). Under it the service may re-attempt this ticket's task once the target base advanced and enqueue the re-attempt for the
 * same two human cards. Additive and optional: absent keeps the human-only requeue. */
export const queueDeliveryIntentSchema = z.literal('service-reattempt');
/** D1a lineage of a service-enqueued re-attempt: the ticket it replaces, the human intent ticket it acts under, its count and typed cause.
 * `approvedBy` is the delegating human; the ticket's actor is that human's service principal (provenance, never a policy principal). */
export const queueReattemptSchema = z.object({ sourceCommandId: identitySchema, intentCommandId: identitySchema, count: counterSchema.positive(),
  cause: queueReasonSchema, approvedBy: actor }).strict().readonly();
/** The service principal acting for one delegating human; it mirrors the MCP derivation and never verifies as a human. */
export const queueServiceActor = (approver: QueueActor): QueueActor =>
  Object.freeze({ id: identitySchema.parse(`${approver.id}/service`), issuer: identitySchema.parse(`${approver.issuer}/service`), subject: approver.subject });
const sameActor = (a: QueueActor, b: QueueActor) => a.id === b.id && a.issuer === b.issuer && a.subject === b.subject;
export const targetQueueRequestSchema = z.object({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  operation: z.enum(['delivery', 'rollback']).optional(), sourceCommandId: identitySchema.optional(), replacesCommandId: identitySchema.optional(), identity: attemptIdentitySchema, target: targetBindingSchema, actor, payloadDigest: digest, policyRevision: identitySchema,
  outputDigest: digest, acceptedRevision: counterSchema, submittedAt: counterSchema, deadline: counterSchema,
  deliveryIntent: queueDeliveryIntentSchema.optional(), reattempt: queueReattemptSchema.optional() }).strict()
  .refine(value => value.deadline > value.submittedAt && ((value.operation === 'rollback') === (value.sourceCommandId !== undefined)), 'QUEUE_EXPIRED')
  // A re-attempt exists only under an intent, as a delivery, by the approver's service principal; a rollback never carries an intent.
  .refine(value => (!value.deliveryIntent || value.operation !== 'rollback') && (!value.reattempt || (value.deliveryIntent !== undefined
    && value.replacesCommandId === undefined && sameActor(value.actor, queueServiceActor(value.reattempt.approvedBy)))), 'QUEUE_AUTHORITY_REQUIRED').readonly();
export type TargetQueueRequest = z.infer<typeof targetQueueRequestSchema>;
/** The human whose authority a ticket's background work uses: the delegating human of a re-attempt, otherwise the submitting actor. */
export const queueApprover = (request: Pick<TargetQueueRequest, 'actor' | 'reattempt'>): QueueActor => request.reattempt?.approvedBy ?? request.actor;
export const targetQueueStateSchema = z.enum(['queued', 'revalidating', 'verifying', 'awaiting-confirmation', 'publishing', 'adopting',
  'reconciling', 'cancelled', 'expired', 'parked', 'settled']);
export const targetQueueOutcomeSchema = z.enum(['adopted', 're-prepared+adopted', 'conflict-needs-reattempt', 'verification-failed', 'target-protected', 'stale-refused']);
export const targetQueueRecordSchema = z.object({ schemaVersion: z.literal(1), request: targetQueueRequestSchema,
  key: digest, ordinal: counterSchema.positive(), revision: counterSchema, state: targetQueueStateSchema,
  ownerInstance: identitySchema.nullable(), epoch: counterSchema, leaseDeadline: counterSchema.nullable(),
  candidate: candidateBindingSchema.nullable(), verification: candidateEvidenceSchema.nullable(), batchDigest: digest.nullable(),
  effectCommandIds: z.array(identitySchema), evidenceRefs: z.array(digest), outcome: targetQueueOutcomeSchema.nullable(),
  /** Additive (BENIMSEME-DEPO-KIMLIGI): the typed code of the failure an effect stopped on, or why a started ticket parked as not applied. */
  reason: queueReasonSchema.nullable().optional() }).strict().readonly();
export type TargetQueueRecord = z.infer<typeof targetQueueRecordSchema>;
export type TargetQueueState = z.infer<typeof targetQueueStateSchema>;
export type TargetQueueOutcome = z.infer<typeof targetQueueOutcomeSchema>;
export class TargetQueueError extends Error {
  constructor(readonly code: 'QUEUE_CONFLICT' | 'QUEUE_CAPACITY' | 'QUEUE_TARGET_BUSY' | 'QUEUE_CORRUPT' | 'QUEUE_AUTHORITY_REQUIRED'
    | 'QUEUE_RECOVERY_REQUIRED' | 'QUEUE_CONFIRMATION_REQUIRED' | 'QUEUE_EXPIRED') { super(code); this.name = 'TargetQueueError'; }
}
export function queueTerminal(state: TargetQueueState): boolean {
  return ['cancelled', 'expired', 'parked', 'settled'].includes(state);
}
/** Unknown is never skipped or expired; recovery needs physical custody, not a lease's wall-clock age. */
export function queueNextState(previous: TargetQueueRecord, state: TargetQueueState): void {
  const transitions: Readonly<Record<TargetQueueState, readonly TargetQueueState[]>> = {
    queued: ['revalidating', 'cancelled', 'expired', 'parked'], revalidating: ['verifying', 'settled', 'cancelled', 'parked', 'reconciling'],
    verifying: ['awaiting-confirmation', 'settled', 'cancelled', 'parked', 'reconciling'],
    'awaiting-confirmation': ['publishing', 'adopting', 'cancelled', 'expired', 'parked', 'reconciling'],
    publishing: ['adopting', 'reconciling'], adopting: ['settled', 'reconciling'],
    reconciling: ['reconciling', 'settled', 'parked'], cancelled: [], expired: [], parked: [], settled: [],
  };
  if (!transitions[previous.state].includes(state)) throw new TargetQueueError('QUEUE_CONFLICT');
}
