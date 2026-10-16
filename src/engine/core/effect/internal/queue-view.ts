import { TargetQueueError, targetQueueRecordSchema, targetDisplaySchema, type TargetQueueRecord, type TargetDisplay } from '#domain/index.js';
export type QueueNextAction = 'wait-service' | 'confirm-batch' | 'watch-reconciliation' | 'new-attempt' | 'select-target' | 'prepare-current' | 'inspect-receipt';
/** The authorized own-ticket projection never leaks physical ordinals, other scopes or an installation-wide backlog count. */
export function projectTargetQueue(input: TargetQueueRecord, descriptor: TargetDisplay, observedAt: number) {
  const record = targetQueueRecordSchema.parse(input), display = targetDisplaySchema.parse(descriptor);
  if (!Number.isSafeInteger(observedAt) || observedAt < record.request.submittedAt) throw new TargetQueueError('QUEUE_CORRUPT');
  let nextAction: QueueNextAction = 'wait-service';
  if (record.state === 'reconciling') nextAction = 'watch-reconciliation';
  else if (record.state === 'awaiting-confirmation') nextAction = 'confirm-batch';
  else if (record.outcome === 'conflict-needs-reattempt' || record.outcome === 'verification-failed') nextAction = 'new-attempt';
  else if (record.outcome === 'target-protected') nextAction = 'select-target';
  else if (record.outcome === 'stale-refused' || ['parked', 'cancelled', 'expired'].includes(record.state)) nextAction = 'prepare-current';
  else if (record.state === 'settled') nextAction = 'inspect-receipt';
  return Object.freeze({ schemaVersion: 1 as const, commandId: record.request.commandId, identity: record.request.identity,
    target: record.request.target.target, display, state: record.state, outcome: record.outcome, revision: record.revision,
    observedAt, freshness: 'last-known' as const, nextAction,
    responsibility: record.state === 'awaiting-confirmation' ? 'human' as const : record.state === 'reconciling' ? 'reconciler' as const : 'service' as const,
    basis: record.candidate ? { observed: record.candidate.observedVersion, effective: record.candidate.effectiveVersion,
      candidate: record.candidate.candidateVersion } : null,
    verification: record.verification ? { phase: record.verification.phase, receipt: record.verification.evidenceReceipt } : null,
    evidenceRefs: record.evidenceRefs });
}
export type TargetQueueView = ReturnType<typeof projectTargetQueue>;
