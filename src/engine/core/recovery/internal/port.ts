import type { AttemptIdentity, AuditRecord, EffectRecord, RecoveryCase, RecoveryDecision, RunSnapshot } from '#domain/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';

/** The termination proof the slot release used (the release receipt's), as the case records it. */
export type RecoveryTermination = Readonly<{ receiptId: string; kind: 'worker-absent' | 'supervisor-exit' | 'created-container-absent'; exitCode: number | null }>;
export type RecoveryContinuationWrite = Readonly<{ previous: RecoveryCase; decision: Extract<RecoveryDecision, { action: 'continue-new-attempt' }>; now: number; timeoutMs: number }>;
/** Seals the continuation event in the writer's transaction (no audit, no effect). */
export type RecoveryAudit = (store: AuditStore, snapshot: RunSnapshot, closed: RecoveryCase) => AuditRecord;
/**
 * S6R-4 ledger port of the recovery cases (v66) and the reads the gate needs. Every write is compare-and-swap; the continuation re-derives its
 * inputs (Run, case, gate set, the task's earlier continued signatures) inside one transaction and writes the Run, the case and the audit event
 * together, or nothing.
 */
export interface RecoveryStore {
  loadCase(scopeId: string, caseId: string): Promise<RecoveryCase | null>;
  loadRun(scopeId: string, runId: string): Promise<RunSnapshot | null>;
  /** The proof of the release receipt `receiptId` (null: no such release). */
  loadTermination(scopeId: string, receiptId: string): Promise<RecoveryTermination | null>;
  /** The gate-set candidates of one lost Attempt: every intent it produced, plus producer-less (pre-S6R-1) intents of its scope still open; at most `limit`. */
  listGateEffects(identity: AttemptIdentity, limit: number): Promise<readonly EffectRecord[]>;
  /** Inserts a new case (`previous` null; an identical stored case replays) or moves one forward from exactly `previous`. */
  saveCase(previous: RecoveryCase | null, next: RecoveryCase): Promise<RecoveryCase>;
  continueLostTask(write: RecoveryContinuationWrite, audit: RecoveryAudit): Promise<Readonly<{ case: RecoveryCase; run: RunSnapshot }>>;
}
