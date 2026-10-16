import { createHash } from 'node:crypto';
import { assertCandidateEvidence, encodeCommandProjection, targetQueueRecordSchema, TargetQueueError,
  type TargetQueueRecord, type TargetBinding } from '#domain/index.js';
import { targetQueueKey } from './queue-key.js';
import type { TargetQueueBounds } from './target-queue.js';
export interface TargetBatchItem { readonly scopeId: string; readonly commandId: string; readonly ordinal: number; readonly revision: number;
  readonly candidateDigest: string; readonly custodyReceipt: string; readonly verificationReceipt: string;
  readonly from: string; readonly to: string; readonly effectCommandIds: readonly string[] }
export interface TargetBatch { readonly schemaVersion: 1; readonly operation: 'publish' | 'adopt' | 'rollback'; readonly target: TargetBinding;
  readonly ownerInstance: string; readonly epoch: number; readonly policyRevision: string; readonly expiresAt: number; readonly items: readonly TargetBatchItem[] }
export function targetBatchDigest(batch: TargetBatch): string { return createHash('sha256').update(encodeCommandProjection('target-batch:1', batch)).digest('hex'); }
/** Select only the already verified FIFO prefix of one target; failures and pending verification cut the chain. No new arrival enters consent. */
export function prepareTargetBatch(input: readonly TargetQueueRecord[], operation: TargetBatch['operation'], bounds: TargetQueueBounds,
  now: number, expiresAt: number): TargetBatch {
  if (expiresAt <= now || !Number.isSafeInteger(expiresAt)) throw new TargetQueueError('QUEUE_EXPIRED');
  const first = input[0];
  if (!first?.ownerInstance) throw new TargetQueueError('QUEUE_TARGET_BUSY');
  const items: TargetBatchItem[] = [];
  for (const value of input.slice(0, bounds.batchSize)) {
    const record = targetQueueRecordSchema.parse(value), candidate = record.candidate, proof = record.verification;
    if ((record.request.operation === 'rollback') !== (operation === 'rollback')) break;
    if (record.state !== 'awaiting-confirmation' || !candidate || !proof || proof.phase !== 'accepted') break;
    if (record.key !== targetQueueKey(first.request.target) || record.ownerInstance !== first.ownerInstance || record.epoch !== first.epoch
      || record.request.policyRevision !== first.request.policyRevision || record.request.deadline <= now) break;
    if (record.ordinal <= (items.at(-1)?.ordinal ?? 0)) throw new TargetQueueError('QUEUE_CONFLICT');
    assertCandidateEvidence(candidate, proof);
    if (targetQueueKey(candidate.target) !== record.key || candidate.outputDigest !== record.request.outputDigest
      || encodeCommandProjection('attempt:1', candidate.identity) !== encodeCommandProjection('attempt:1', record.request.identity)) throw new TargetQueueError('QUEUE_CONFLICT');
    if (items.length && candidate.effectiveVersion !== items.at(-1)!.to) break;
    items.push({ scopeId: record.request.identity.scopeId, commandId: record.request.commandId, ordinal: record.ordinal, revision: record.revision,
      candidateDigest: candidate.candidateDigest, custodyReceipt: candidate.custodyReceipt, verificationReceipt: proof.evidenceReceipt,
      from: operation === 'rollback' ? candidate.candidateVersion : candidate.effectiveVersion, to: operation === 'rollback' ? candidate.effectiveVersion : candidate.candidateVersion, effectCommandIds: [...record.effectCommandIds] });
    if (operation === 'rollback') break;
  }
  if (!items.length) throw new TargetQueueError('QUEUE_CONFIRMATION_REQUIRED');
  return Object.freeze({ schemaVersion: 1, operation, target: first.request.target, ownerInstance: first.ownerInstance,
    epoch: first.epoch, policyRevision: first.request.policyRevision, expiresAt: Math.min(expiresAt, ...input.slice(0, items.length).map(r => r.request.deadline)), items: Object.freeze(items) });
}
