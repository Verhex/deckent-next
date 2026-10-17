import { targetQueueKey } from './queue-key.js';
import { TargetQueueError, targetQueueRecordSchema, assertCandidateEvidence, type TargetQueueRecord, type TargetQueueOutcome, type TargetBinding } from '#domain/index.js';
import type { TargetQueueApplication, TargetQueueStore } from './target-queue.js';
import { targetBatchDigest, type TargetBatch, type TargetBatchItem } from './target-batch.js';
/** `not-applied`: observed under the current generation that the move did not happen (lookup only; nothing written). `refused` with
 * evidence: the journal intent was released as not applied and the receipt names that observation. */
export type QueueEffectResult = Readonly<{ state: 'settled'; evidenceRefs: readonly string[] } | { state: 'unknown' } | { state: 'not-applied' }
  | { state: 'refused'; evidenceRefs?: readonly string[] }>;
/** The typed code an effect failed with; an untyped failure keeps no text (messages may carry paths or secrets). */
export const reasonOf = (error: unknown) => { const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : null; };
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
  /** Re-observes under `fence` and, only if the move still provably did not happen, releases the journal intent: `refused` + receipt. */
  release?(record: TargetQueueRecord, fence: string): Promise<QueueEffectResult>;
}
export interface TargetBatchConsents {
  /** Checks a service-issued, operation-bound capability; this is not a client boolean or a general EffectConfirmation bypass. */
  assert(batch: TargetBatch): Promise<void>;
}
type ExecutedItem = Readonly<{ commandId: string; published: boolean; state: 'settled' | 'refused' | 'unknown'; reason?: string | undefined }>;
export interface TargetBatchExecution { readonly settledPrefix: number; readonly items: readonly ExecutedItem[] }
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
    // The first item is validated (read-only, incl. fence/journal agreement) before the generation is written: a refusal writes nothing.
    let fence: string | null = null;
    const outcomes: ExecutedItem[] = [];
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
      await this.effects.validate(record, item, fence ?? '');
      fence ??= await this.effects.fence(adopt.target, adopt.ownerInstance, adopt.epoch);
      await this.consents.assert(publish); await this.consents.assert(adopt);
      record = this.app.transition(record, { state: 'publishing', batchDigest: targetBatchDigest(adopt) });
      let published = false;
      try {
        const publication = await this.effects.publish(record, fence);
        if (publication.state !== 'settled' || !publication.evidenceRefs.length) {
          record = this.app.transition(record, { state: 'reconciling' });
          outcomes.push({ commandId: item.commandId, published: false, state: publication.state === 'refused' ? 'refused' : 'unknown' }); break;
        }
        published = true;
        record = this.app.transition(record, { state: 'adopting', evidenceRefs: [...record.evidenceRefs, ...publication.evidenceRefs] });
        await this.consents.assert(adopt); await this.effects.validate(record, item, fence);
        const adoption = await this.effects.adopt(record, fence);
        if (adoption.state !== 'settled') {
          record = this.app.transition(record, { state: 'reconciling' });
          outcomes.push({ commandId: item.commandId, published, state: adoption.state === 'refused' ? 'refused' : 'unknown' }); break;
        }
        if (!adoption.evidenceRefs.length) throw new TargetQueueError('QUEUE_RECOVERY_REQUIRED');
        const outcome: TargetQueueOutcome = record.candidate!.effectiveVersion === record.candidate!.observedVersion ? 'adopted' : 're-prepared+adopted';
        this.app.transition(record, { state: 'settled', outcome, evidenceRefs: [...record.evidenceRefs, ...adoption.evidenceRefs] });
        outcomes.push({ commandId: item.commandId, published, state: 'settled' }); settledPrefix++;
      } catch (error) {
        const stop = await this.stopped(item, error);
        outcomes.push({ commandId: item.commandId, published, ...stop }); if (stop.state === 'settled') settledPrefix++; break;
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
    await this.effects.validate(record, item, '');
    const fence = await this.effects.fence(batch.target, batch.ownerInstance, batch.epoch);
    await this.effects.validate(record, item, fence); await this.consents.assert(batch);
    record = this.app.transition(record, { state: 'adopting', batchDigest: targetBatchDigest(batch) });
    try {
      const result = await this.effects.compensate(record, fence);
      if (result.state !== 'settled' || !result.evidenceRefs.length) throw new TargetQueueError('QUEUE_RECOVERY_REQUIRED');
      this.app.transition(record, { state: 'settled', outcome: null, evidenceRefs: [...record.evidenceRefs, ...result.evidenceRefs] });
      return { settledPrefix: 1, items: [{ commandId: item.commandId, published: false, state: 'settled' }] };
    } catch (error) {
      const stop = await this.stopped(item, error);
      return { settledPrefix: stop.state === 'settled' ? 1 : 0, items: [{ commandId: item.commandId, published: false, ...stop }] };
    }
  }
  /** A failed effect keeps its typed code on the ticket (and so in its audit event) and goes to reconciliation at once. Only the fenced
   * observation decides: a provably not applied move parks with that evidence (`refused`); anything else stays reconciling (`unknown`). */
  private async stopped(item: TargetBatchItem, error: unknown): Promise<Pick<ExecutedItem, 'state' | 'reason'>> {
    let current = this.read(item);
    const reason = reasonOf(error);
    if (current.state === 'publishing' || current.state === 'adopting') current = this.app.transition(current, { state: 'reconciling', ...(reason ? { reason } : {}) });
    if (current.state === 'reconciling') try { current = await this.reconcile(current); } catch { /* stays reconciling; the periodic reconciler retries */ }
    const typed = current.reason ?? reason;
    return { state: current.state === 'parked' ? 'refused' : current.state === 'settled' ? 'settled' : 'unknown', ...(typed ? { reason: typed } : {}) };
  }
  async reconcile(record: TargetQueueRecord): Promise<TargetQueueRecord> {
    if (record.state !== 'reconciling' || !record.ownerInstance) throw new TargetQueueError('QUEUE_CONFLICT');
    const fence = await this.effects.fence(record.request.target, record.ownerInstance, record.epoch);
    const found = await this.effects.lookup(record, fence);
    if (found.state === 'not-applied' && this.effects.release) {
      const released = await this.effects.release(record, fence);
      if (released.state !== 'refused' || !released.evidenceRefs?.length) return record;
      return this.app.transition(record, { state: 'parked', reason: record.reason ?? 'ADOPTION_NOT_APPLIED', evidenceRefs: [...record.evidenceRefs, ...released.evidenceRefs] });
    }
    if (found.state !== 'settled' || !found.evidenceRefs.length) return record;
    // Lookup must establish the complete adoption, not merely delivery publication. No silent publication/adoption replay here.
    return this.app.transition(record, { state: 'settled', outcome: record.request.operation === 'rollback' ? null : record.candidate?.effectiveVersion === record.candidate?.observedVersion ? 'adopted' : 're-prepared+adopted',
      evidenceRefs: [...record.evidenceRefs, ...found.evidenceRefs] });
  }
}
