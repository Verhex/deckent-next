import { z } from 'zod';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
import { counterSchema, identitySchema, clientCommandIdSchema } from '#domain/core/primitives/index.js';
import { targetBindingSchema, candidateBindingSchema, candidateEvidenceSchema } from './candidate.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const actor = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly();
export const targetQueueRequestSchema = z.object({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  identity: attemptIdentitySchema, target: targetBindingSchema, actor, payloadDigest: digest, policyRevision: identitySchema,
  outputDigest: digest, acceptedRevision: counterSchema, submittedAt: counterSchema, deadline: counterSchema }).strict().refine(value => value.deadline > value.submittedAt, 'QUEUE_EXPIRED').readonly();
export type TargetQueueRequest = z.infer<typeof targetQueueRequestSchema>;
export const targetQueueStateSchema = z.enum(['queued', 'revalidating', 'verifying', 'awaiting-confirmation', 'publishing', 'adopting',
  'reconciling', 'cancelled', 'expired', 'parked', 'settled']);
export const targetQueueOutcomeSchema = z.enum(['adopted', 're-prepared+adopted', 'conflict-needs-reattempt', 'verification-failed', 'target-protected', 'stale-refused']);
export const targetQueueRecordSchema = z.object({ schemaVersion: z.literal(1), request: targetQueueRequestSchema,
  key: digest, ordinal: counterSchema.positive(), revision: counterSchema, state: targetQueueStateSchema,
  ownerInstance: identitySchema.nullable(), epoch: counterSchema, leaseDeadline: counterSchema.nullable(),
  candidate: candidateBindingSchema.nullable(), verification: candidateEvidenceSchema.nullable(), batchDigest: digest.nullable(),
  effectCommandIds: z.array(identitySchema), evidenceRefs: z.array(digest), outcome: targetQueueOutcomeSchema.nullable() }).strict().readonly();
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
    queued: ['revalidating', 'cancelled', 'expired', 'parked'], revalidating: ['verifying', 'settled', 'cancelled', 'parked'],
    verifying: ['awaiting-confirmation', 'settled', 'cancelled', 'parked'],
    'awaiting-confirmation': ['publishing', 'cancelled', 'expired', 'parked'],
    publishing: ['adopting', 'reconciling'], adopting: ['settled', 'reconciling'],
    reconciling: ['settled'], cancelled: [], expired: [], parked: [], settled: [],
  };
  if (!transitions[previous.state].includes(state)) throw new TargetQueueError('QUEUE_CONFLICT');
}
