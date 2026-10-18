import { TargetQueueError, queueTerminal, type TargetQueueRecord, type CandidateBinding, type CandidateEvidence } from '#domain/index.js';
import type { TargetQueueApplication, TargetQueueBounds } from './target-queue.js';
import { reasonOf } from './batch-execution.js';
export interface TargetQueuePreparation {
  /** Trusted producer checks source, accepted Task and live target, then prepares on the preceding verified candidate. */
  prepare(record: TargetQueueRecord, predecessor: TargetQueueRecord | null): Promise<CandidateBinding>;
  admitVerification(record: TargetQueueRecord): Promise<void>;
  evidence(record: TargetQueueRecord): Promise<CandidateEvidence>;
  effectIds(record: TargetQueueRecord): readonly string[];
}
/** One target's bounded service turn. Waiting on verification/human input never holds a worker or request slot. */
export class TargetQueueDriver {
  constructor(private readonly app: TargetQueueApplication, private readonly bounds: TargetQueueBounds,
    private readonly preparation: TargetQueuePreparation, private readonly owner: string, private readonly now: () => number) {}
  async advance(input: readonly TargetQueueRecord[]): Promise<void> {
    const first = input[0]; if (!first) return;
    let records = input;
    if (first.state === 'queued' && first.request.operation === 'rollback') return;
    if (first.state === 'queued') {
      if (this.now() >= first.request.deadline) { this.app.transition(first, { state: 'expired' }); return; }
      if (this.now() < first.request.submittedAt + this.bounds.batchWindowMs) return;
      records = this.app.reserve(first, this.owner, this.now());
    }
    if (records[0]?.ownerInstance !== this.owner) throw new TargetQueueError('QUEUE_RECOVERY_REQUIRED');
    let previous: TargetQueueRecord | null = null;
    for (let record of records) {
      if (record.epoch !== records[0]!.epoch || record.ownerInstance !== this.owner || queueTerminal(record.state)) break;
      if (record.state === 'reconciling' || record.state === 'publishing' || record.state === 'adopting') return;
      if (this.now() >= record.request.deadline) {
        this.parkSuffix(records, record.ordinal); return;
      }
      if (record.state === 'revalidating') {
        let candidate: CandidateBinding;
        try { candidate = await this.preparation.prepare(record, previous); }
        catch (error) {
          // Every refusal keeps its typed code on the ticket (view and audit); an untyped failure gets the preparation code, never null.
          const refused = reasonOf(error) ?? 'QUEUE_PREPARATION_REFUSED';
          // D1a: a base-advanced ticket under delivery intent whose lineage already used the bound ends typed, owned by a human (no new attempt).
          const reason = refused === 'PATCH_BASE_ADVANCED' && record.request.deliveryIntent && (record.request.reattempt?.count ?? 0) >= (this.bounds.reattempts ?? 0)
            ? 'DELIVERY_REATTEMPT_EXHAUSTED' : refused;
          const outcome = refused === 'PATCH_BASE_ADVANCED' ? 'conflict-needs-reattempt' : reason === 'QUEUE_AUTHORITY_REQUIRED' ? 'target-protected' : 'stale-refused';
          this.app.transition(record, { state: 'settled', outcome, reason }); this.parkSuffix(records, record.ordinal + 1); return;
        }
        record = this.app.transition(record, { state: 'verifying', candidate, effectCommandIds: [...this.preparation.effectIds(record)] });
        // The immutable candidate is durable BEFORE a verification Run can acquire it. Interrupted admission is not silently repeated:
        // a failed admission parks the ticket with its typed code (view and audit), instead of waiting silently for the verification timeout.
        try { await this.preparation.admitVerification(record); }
        catch (error) {
          this.app.transition(record, { state: 'parked', reason: reasonOf(error) ?? 'QUEUE_VERIFICATION_NOT_ADMITTED' });
          this.parkSuffix(records, record.ordinal + 1); return;
        }
      }
      if (record.state === 'verifying') {
        const proof = await this.preparation.evidence(record);
        if (proof.phase === 'pending' || proof.phase === 'unknown') {
          if (this.now() >= record.request.submittedAt + this.bounds.verificationTimeoutMs) this.parkSuffix(records, record.ordinal);
          return;
        }
        if (proof.phase !== 'accepted') {
          this.app.transition(record, { state: 'settled', outcome: 'verification-failed', verification: proof });
          this.parkSuffix(records, record.ordinal + 1); return;
        }
        record = this.app.transition(record, { state: 'awaiting-confirmation', verification: proof });
      }
      if (record.state !== 'awaiting-confirmation') return;
      previous = record;
    }
  }
  private parkSuffix(records: readonly TargetQueueRecord[], ordinal: number) {
    for (const before of records) {
      const record = this.app.current(before);
      if (record.ordinal >= ordinal && ['revalidating', 'verifying', 'awaiting-confirmation'].includes(record.state)) this.app.transition(record, { state: 'parked' });
    }
  }
}
