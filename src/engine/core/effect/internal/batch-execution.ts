import { targetQueueKey } from './queue-key.js';
import { TargetQueueError, targetQueueRecordSchema, assertCandidateEvidence, type TargetQueueRecord, type TargetQueueOutcome, type TargetBinding } from '#domain/index.js';
import type { TargetQueueApplication, TargetQueueStore } from './target-queue.js';
import { targetBatchDigest, type TargetBatch, type TargetBatchItem } from './target-batch.js';
export type QueueEffectResult = Readonly<{ state: 'settled'; evidenceRefs: readonly string[] } | { state: 'unknown' } | { state: 'refused' }>;
/** Calls existing delivery/adoption or EffectApplication owners; this scheduler is not an external effect engine. */
export interface TargetBatchEffects {
  /** Advance physical fencing before recovery; TTL is never sufficient. Fence is also checked inside every adapter effect transaction. */
  fence(target: TargetBinding, ownerInstance: string, epoch: number): Promise<string>;
  /** Recheck principal/session, policy, accepted Attempt, source binding, protection, live target version and physical generation. */
  validate(record: TargetQueueRecord, item: TargetBatchItem, fence: string): Promise<void>;
  publish(record: TargetQueueRecord, fence: string): Promise<QueueEffectResult>;
  adopt(record: TargetQueueRecord, fence: string): Promise<QueueEffectResult>;
  compensate?(record: TargetQueueRecord, fence: string): Promise<QueueEffectResult>;
  /** Exact custody/fence lookup; never repeats an uncertain external write. */
  lookup(record: TargetQueueRecord, fence: string): Promise<QueueEffectResult>;
}
export interface TargetBatchConsents {
  /** Checks a service-issued, operation-bound capability; this is not a client boolean or a general EffectConfirmation bypass. */
  assert(batch: TargetBatch): Promise<void>;
}
export interface TargetBatchExecution { readonly settledPrefix: number; readonly items: readonly Readonly<{ commandId: string; published: boolean; state: 'settled' | 'refused' | 'unknown' }>[] }
/** Ordered, non-atomic prefix execution. Any failure stops the suffix; already settled items remain adopted. */
export class TargetBatchExecutor {
  constructor(private readonly app: TargetQueueApplication, private readonly store: TargetQueueStore, private readonly effects: TargetBatchEffects,
    private readonly consents: TargetBatchConsents, private readonly now: () => number) {}
  private read(item: TargetBatchItem): TargetQueueRecord {
    const record = this.store.load(item.scopeId, item.commandId);
    if (!record) throw new TargetQueueError('QUEUE_CONFLICT');
    return targetQueueRecordSchema.parse(record);
  }
  async execute(publish: TargetBatch, adopt: TargetBatch): Promise<TargetBatchExecution> {
    if (publish.operation !== 'publish' || adopt.operation !== 'adopt'
      || targetBatchDigest({ ...publish, operation: 'adopt' }) !== targetBatchDigest(adopt)) throw new TargetQueueError('QUEUE_CONFLICT');
    await this.consents.assert(publish); await this.consents.assert(adopt);
    const fence = await this.effects.fence(adopt.target, adopt.ownerInstance, adopt.epoch);
    const outcomes: { commandId: string; published: boolean; state: 'settled' | 'refused' | 'unknown' }[] = [];
    let settledPrefix = 0;
    for (const item of adopt.items) {
      let record = this.read(item);
      if (record.revision !== item.revision || record.state !== 'awaiting-confirmation' || record.ordinal !== item.ordinal
        || record.ownerInstance !== adopt.ownerInstance || record.epoch !== adopt.epoch || !record.candidate || !record.verification
        || record.candidate.candidateDigest !== item.candidateDigest || record.candidate.custodyReceipt !== item.custodyReceipt
        || record.verification.evidenceReceipt !== item.verificationReceipt || record.key !== targetQueueKey(adopt.target)
        || record.request.policyRevision !== adopt.policyRevision || record.candidate.effectiveVersion !== item.from || record.candidate.candidateVersion !== item.to
        || JSON.stringify(record.effectCommandIds) !== JSON.stringify(item.effectCommandIds)) throw new TargetQueueError('QUEUE_CONFLICT');
      assertCandidateEvidence(record.candidate, record.verification);
      if (this.now() >= adopt.expiresAt || this.now() >= record.request.deadline) throw new TargetQueueError('QUEUE_EXPIRED');
      await this.effects.validate(record, item, fence);
      await this.consents.assert(publish); await this.consents.assert(adopt);
      record = this.app.transition(record, { state: 'publishing', batchDigest: targetBatchDigest(adopt) });
      let published = false;
      try {
        const publication = await this.effects.publish(record, fence);
        if (publication.state !== 'settled' || !publication.evidenceRefs.length) {
          record = this.app.transition(record, { state: 'reconciling' });
          outcomes.push({ commandId: item.commandId, published: false, state: publication.state === 'settled' ? 'unknown' : publication.state }); break;
        }
        published = true;
        record = this.app.transition(record, { state: 'adopting', evidenceRefs: [...record.evidenceRefs, ...publication.evidenceRefs] });
        await this.consents.assert(adopt); await this.effects.validate(record, item, fence);
        const adoption = await this.effects.adopt(record, fence);
        if (adoption.state !== 'settled') {
          record = this.app.transition(record, { state: 'reconciling' });
          outcomes.push({ commandId: item.commandId, published, state: adoption.state }); break;
        }
        if (!adoption.evidenceRefs.length) throw new TargetQueueError('QUEUE_RECOVERY_REQUIRED');
        const outcome: TargetQueueOutcome = record.candidate!.effectiveVersion === record.candidate!.observedVersion ? 'adopted' : 're-prepared+adopted';
        this.app.transition(record, { state: 'settled', outcome, evidenceRefs: [...record.evidenceRefs, ...adoption.evidenceRefs] });
        outcomes.push({ commandId: item.commandId, published, state: 'settled' }); settledPrefix++;
      } catch {
        const current = this.read(item);
        if (current.state === 'publishing' || current.state === 'adopting') this.app.transition(current, { state: 'reconciling' });
        outcomes.push({ commandId: item.commandId, published, state: 'unknown' }); break;
      }
    }
    return { settledPrefix, items: outcomes };
  }
  async rollback(batch: TargetBatch): Promise<TargetBatchExecution> {
    const item = batch.items[0];
    if (batch.operation !== 'rollback' || batch.items.length !== 1 || !item || !this.effects.compensate) throw new TargetQueueError('QUEUE_CONFLICT');
    let record = this.read(item);
    if (record.request.operation !== 'rollback' || record.state !== 'awaiting-confirmation' || record.revision !== item.revision || record.ordinal !== item.ordinal
      || record.key !== targetQueueKey(batch.target) || record.ownerInstance !== batch.ownerInstance || record.epoch !== batch.epoch
      || record.candidate?.candidateDigest !== item.candidateDigest || record.candidate.candidateVersion !== item.from || record.candidate.effectiveVersion !== item.to
      || record.verification?.evidenceReceipt !== item.verificationReceipt || JSON.stringify(record.effectCommandIds) !== JSON.stringify(item.effectCommandIds)) throw new TargetQueueError('QUEUE_CONFLICT');
    assertCandidateEvidence(record.candidate, record.verification);
    if (this.now() >= batch.expiresAt || this.now() >= record.request.deadline) throw new TargetQueueError('QUEUE_EXPIRED');
    await this.consents.assert(batch);
    const fence = await this.effects.fence(batch.target, batch.ownerInstance, batch.epoch);
    await this.effects.validate(record, item, fence); await this.consents.assert(batch);
    record = this.app.transition(record, { state: 'adopting', batchDigest: targetBatchDigest(batch) });
    try {
      const result = await this.effects.compensate(record, fence);
      if (result.state !== 'settled' || !result.evidenceRefs.length) throw new TargetQueueError('QUEUE_RECOVERY_REQUIRED');
      this.app.transition(record, { state: 'settled', outcome: null, evidenceRefs: [...record.evidenceRefs, ...result.evidenceRefs] });
      return { settledPrefix: 1, items: [{ commandId: item.commandId, published: false, state: 'settled' }] };
    } catch {
      this.app.transition(this.read(item), { state: 'reconciling' });
      return { settledPrefix: 0, items: [{ commandId: item.commandId, published: false, state: 'unknown' }] };
    }
  }
  async reconcile(record: TargetQueueRecord): Promise<TargetQueueRecord> {
    if (record.state !== 'reconciling' || !record.ownerInstance) throw new TargetQueueError('QUEUE_CONFLICT');
    const fence = await this.effects.fence(record.request.target, record.ownerInstance, record.epoch);
    const found = await this.effects.lookup(record, fence);
    if (found.state !== 'settled' || !found.evidenceRefs.length) return record;
    // Lookup must establish the complete adoption, not merely delivery publication. No silent publication/adoption replay here.
    return this.app.transition(record, { state: 'settled', outcome: record.request.operation === 'rollback' ? null : record.candidate?.effectiveVersion === record.candidate?.observedVersion ? 'adopted' : 're-prepared+adopted',
      evidenceRefs: [...record.evidenceRefs, ...found.evidenceRefs] });
  }
}
