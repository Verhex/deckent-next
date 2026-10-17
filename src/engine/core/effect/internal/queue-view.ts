import { z } from 'zod';
import { TargetQueueError, targetQueueRecordSchema, targetDisplaySchema, identitySchema, attemptIdentitySchema, effectTargetRefSchema,
  targetQueueStateSchema, targetQueueOutcomeSchema, queueReasonSchema, type TargetQueueRecord, type TargetDisplay } from '#domain/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const targetQueueViewSchema = z.object({ schemaVersion: z.literal(1), commandId: identitySchema, identity: attemptIdentitySchema,
  operation: z.enum(['delivery', 'rollback']), target: effectTargetRefSchema, display: targetDisplaySchema, state: targetQueueStateSchema, outcome: targetQueueOutcomeSchema.nullable(), revision: z.number().int().nonnegative().safe(),
  observedAt: z.number().int().nonnegative().safe(), freshness: z.literal('last-known'), position: z.number().int().positive().safe().nullable(),
  nextAction: z.enum(['wait-service', 'confirm-batch', 'watch-reconciliation', 'new-attempt', 'select-target', 'prepare-current', 'inspect-receipt']),
  responsibility: z.enum(['human', 'reconciler', 'service']), basis: z.object({ observed: z.string(), effective: z.string(), candidate: z.string() }).strict().nullable(),
  verification: z.object({ phase: z.enum(['accepted', 'failed', 'pending', 'cancelled', 'unknown']), receipt: digest }).strict().nullable(), evidenceRefs: z.array(digest),
  reason: queueReasonSchema.nullable().optional() }).strict().readonly();
export type QueueNextAction = 'wait-service' | 'confirm-batch' | 'watch-reconciliation' | 'new-attempt' | 'select-target' | 'prepare-current' | 'inspect-receipt';
/** The authorized own-ticket projection never leaks physical ordinals, other scopes or an installation-wide backlog count. */
export function projectTargetQueue(input: TargetQueueRecord, descriptor: TargetDisplay, observedAt: number, position: number | null = null) {
  const record = targetQueueRecordSchema.parse(input), display = targetDisplaySchema.parse(descriptor);
  if (!Number.isSafeInteger(observedAt) || observedAt < record.request.submittedAt) throw new TargetQueueError('QUEUE_CORRUPT');
  let nextAction: QueueNextAction = 'wait-service';
  if (record.state === 'reconciling') nextAction = 'watch-reconciliation';
  else if (record.state === 'awaiting-confirmation') nextAction = 'confirm-batch';
  else if (record.outcome === 'conflict-needs-reattempt' || record.outcome === 'verification-failed' || (record.state === 'parked' && record.reason && record.batchDigest !== null)) nextAction = 'new-attempt';
  else if (record.outcome === 'target-protected') nextAction = 'select-target';
  else if (record.outcome === 'stale-refused' || ['parked', 'cancelled', 'expired'].includes(record.state)) nextAction = 'prepare-current';
  else if (record.state === 'settled') nextAction = 'inspect-receipt';
  return Object.freeze({ schemaVersion: 1 as const, commandId: record.request.commandId, identity: record.request.identity,
    operation: record.request.operation ?? 'delivery', target: record.request.target.target, display, state: record.state, outcome: record.outcome, revision: record.revision,
    observedAt, freshness: 'last-known' as const, position, nextAction,
    responsibility: record.state === 'awaiting-confirmation' ? 'human' as const : record.state === 'reconciling' ? 'reconciler' as const : 'service' as const,
    basis: record.candidate ? { observed: record.candidate.observedVersion, effective: record.candidate.effectiveVersion,
      candidate: record.candidate.candidateVersion } : null,
    verification: record.verification ? { phase: record.verification.phase, receipt: record.verification.evidenceReceipt } : null,
    evidenceRefs: record.evidenceRefs, reason: record.reason ?? null });
}
export type TargetQueueView = z.infer<typeof targetQueueViewSchema>;
