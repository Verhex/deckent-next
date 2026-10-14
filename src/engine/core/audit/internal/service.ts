import type { AuditVerification } from '#domain/index.js';
export interface AuditServiceStatus { readonly status: 'ready' | 'degraded'; readonly reason?: 'unavailable' | 'limit' | 'not-verified'; readonly verifications: readonly AuditVerification[] }
export class AuditCheckpointCycleError extends Error {
  constructor(readonly reason: 'unavailable' | 'limit') { super('AUDIT_CHECKPOINT_CYCLE'); this.name = 'AuditCheckpointCycleError'; }
}
/** Ready only when at least one scope was verified and every verification matched; nothing verified (not yet run, empty ledger) is never ready. */
export const auditServiceStatus = (verifications: readonly AuditVerification[]): AuditServiceStatus => Object.freeze(!verifications.length
  ? { status: 'degraded' as const, reason: 'not-verified' as const, verifications: Object.freeze([]) }
  : { status: verifications.some(value => value.status !== 'match') ? 'degraded' as const : 'ready' as const, verifications: Object.freeze([...verifications]) });
/** Service-owned, non-overlapping schedule. A failed cycle is reported; no retries or rebaseline. Stop drains the in-flight cycle. */
export class AuditCheckpointMonitor {
  private current: AuditServiceStatus = auditServiceStatus([]);
  constructor(private readonly cycle: () => Promise<readonly AuditVerification[]>, private readonly publish: (status: AuditServiceStatus) => void | Promise<void>) {}
  get status(): AuditServiceStatus { return this.current; }
  async check(): Promise<void> {
    try { this.current = auditServiceStatus(await this.cycle()); }
    catch (error) { this.current = Object.freeze({ status: 'degraded', reason: error instanceof AuditCheckpointCycleError ? error.reason : 'unavailable', verifications: [] }); }
    try { await this.publish(this.current); } catch { /* Presentation cannot change integrity state. */ }
  }
  async run(intervalMs: number, signal: AbortSignal, wait: (milliseconds: number, signal: AbortSignal) => Promise<void>): Promise<void> {
    while (!signal.aborted) {
      await wait(intervalMs, signal); if (signal.aborted) return;
      await this.check();
    }
  }
}
