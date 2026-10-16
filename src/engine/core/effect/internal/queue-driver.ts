import { TargetQueueError, queueTerminal, type TargetQueueRecord, type CandidateBinding, type CandidateEvidence } from '#domain/index.js';
import type { TargetQueueApplication, TargetQueueBounds } from './target-queue.js';
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
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          const outcome = code === 'PATCH_BASE_ADVANCED' ? 'conflict-needs-reattempt' : code === 'QUEUE_AUTHORITY_REQUIRED' ? 'target-protected' : 'stale-refused';
          this.app.transition(record, { state: 'settled', outcome }); this.parkSuffix(records, record.ordinal + 1); return;
        }
        record = this.app.transition(record, { state: 'verifying', candidate, effectCommandIds: [...this.preparation.effectIds(record)] });
        // The immutable candidate is durable BEFORE a verification Run can acquire it. Interrupted admission is not silently repeated.
        await this.preparation.admitVerification(record);
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
