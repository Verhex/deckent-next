import { z } from 'zod';
import { TargetQueueError, targetQueueRecordSchema, targetDisplaySchema, identitySchema, attemptIdentitySchema, effectTargetRefSchema,
  targetQueueStateSchema, targetQueueOutcomeSchema, queueReasonSchema, type TargetQueueRecord, type TargetDisplay } from '#domain/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** `waiting-base`: no re-attempt Run yet; the service starts it once the live target base moved past the original output (a conflict against
 * an earlier candidate of the same batch waits for that candidate's adoption); `awaiting-approval`: policy asks a human to approve the
 * re-attempt Run (its normal Run-create card); `running`: the re-attempt Run works on the current base; `enqueued`: its ticket waits in the
 * queue for the same two cards; `refused`/`failed`/`exhausted`: final, a human decides. */
export const queueReattemptViewSchema = z.object({ state: z.enum(['waiting-base', 'awaiting-approval', 'running', 'enqueued', 'refused', 'failed', 'exhausted']),
  count: z.number().int().nonnegative().safe(), bound: z.number().int().nonnegative().safe().optional(), cause: queueReasonSchema,
  runId: identitySchema.optional(), commandId: identitySchema.optional(), reason: queueReasonSchema.optional() }).strict().readonly();
export type QueueReattemptView = z.infer<typeof queueReattemptViewSchema>;
export const targetQueueViewSchema = z.object({ schemaVersion: z.literal(1), commandId: identitySchema, identity: attemptIdentitySchema,
  operation: z.enum(['delivery', 'rollback']), target: effectTargetRefSchema, display: targetDisplaySchema, state: targetQueueStateSchema, outcome: targetQueueOutcomeSchema.nullable(), revision: z.number().int().nonnegative().safe(),
  observedAt: z.number().int().nonnegative().safe(), freshness: z.literal('last-known'), position: z.number().int().positive().safe().nullable(),
  nextAction: z.enum(['wait-service', 'confirm-batch', 'watch-reconciliation', 'new-attempt', 'select-target', 'prepare-current', 'inspect-receipt', 'approve-run']),
  responsibility: z.enum(['human', 'reconciler', 'service']), basis: z.object({ observed: z.string(), effective: z.string(), candidate: z.string() }).strict().nullable(),
  verification: z.object({ phase: z.enum(['accepted', 'failed', 'pending', 'cancelled', 'unknown']), receipt: digest }).strict().nullable(), evidenceRefs: z.array(digest),
  reason: queueReasonSchema.nullable().optional(),
  /** D1a: the service re-attempt of a base-advanced ticket under delivery intent, or why none runs (typed). Absent without an intent. */
  reattempt: queueReattemptViewSchema.optional() }).strict().readonly();
export type QueueNextAction = 'wait-service' | 'confirm-batch' | 'watch-reconciliation' | 'new-attempt' | 'select-target' | 'prepare-current' | 'inspect-receipt' | 'approve-run';
/** The authorized own-ticket projection never leaks physical ordinals, other scopes or an installation-wide backlog count. */
export function projectTargetQueue(input: TargetQueueRecord, descriptor: TargetDisplay, observedAt: number, position: number | null = null, live?: QueueReattemptView) {
  const record = targetQueueRecordSchema.parse(input), display = targetDisplaySchema.parse(descriptor);
  // The record alone proves an exhausted lineage; the service supplies the live state of a running one (Run and successor ticket).
  const reattempt = live ? queueReattemptViewSchema.parse(live) : record.reason === 'DELIVERY_REATTEMPT_EXHAUSTED' ? { state: 'exhausted' as const,
    count: record.request.reattempt?.count ?? 0, cause: record.request.reattempt?.cause ?? 'PATCH_BASE_ADVANCED', reason: record.reason } : undefined;
  const serviceOwned = reattempt && ['waiting-base', 'running', 'enqueued'].includes(reattempt.state);
  if (!Number.isSafeInteger(observedAt) || observedAt < record.request.submittedAt) throw new TargetQueueError('QUEUE_CORRUPT');
  let nextAction: QueueNextAction = 'wait-service';
  if (record.state === 'reconciling') nextAction = 'watch-reconciliation';
  else if (record.state === 'awaiting-confirmation') nextAction = 'confirm-batch';
  else if (serviceOwned) nextAction = 'wait-service';
  else if (reattempt?.state === 'awaiting-approval') nextAction = 'approve-run';
  else if (record.outcome === 'conflict-needs-reattempt' || record.outcome === 'verification-failed' || (record.state === 'parked' && record.reason && record.batchDigest !== null)) nextAction = 'new-attempt';
  else if (record.outcome === 'target-protected') nextAction = 'select-target';
  else if (record.outcome === 'stale-refused' || ['parked', 'cancelled', 'expired'].includes(record.state)) nextAction = 'prepare-current';
  else if (record.state === 'settled') nextAction = 'inspect-receipt';
  return Object.freeze({ schemaVersion: 1 as const, commandId: record.request.commandId, identity: record.request.identity,
    operation: record.request.operation ?? 'delivery', target: record.request.target.target, display, state: record.state, outcome: record.outcome, revision: record.revision,
    observedAt, freshness: 'last-known' as const, position, nextAction,
    responsibility: record.state === 'awaiting-confirmation' || (reattempt && !serviceOwned) ? 'human' as const : record.state === 'reconciling' ? 'reconciler' as const : 'service' as const,
    basis: record.candidate ? { observed: record.candidate.observedVersion, effective: record.candidate.effectiveVersion,
      candidate: record.candidate.candidateVersion } : null,
    verification: record.verification ? { phase: record.verification.phase, receipt: record.verification.evidenceReceipt } : null,
    evidenceRefs: record.evidenceRefs, reason: record.reason ?? null, ...(reattempt ? { reattempt } : {}) });
}
export type TargetQueueView = z.infer<typeof targetQueueViewSchema>;
