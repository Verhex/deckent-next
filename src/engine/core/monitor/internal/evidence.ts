import type { RunSnapshot, WorkerModelView } from '#domain/index.js';
import type { MonitorDeliveryState, MonitorMap } from './contract.js';
import type { RuntimeServiceDescriptor } from '#engine/core/runtime/index.js';
import type { WorkerObservation } from '#engine/core/worker-observation/index.js';

/**
 * MONITOR-DATA read model: what a read-only ledger reader proves about one installation. Every time field is epoch ms copied from a
 * durable ledger record (never sampled, never guessed); null when the record carries none or the ledger version predates it.
 */
export interface MonitorLedgerDispatch {
  readonly launch: 'pending' | 'granted' | 'prevented-before-launch';
  /** `dispatches.record.grant.grantedAt`: the launch grant (linearization point), not proof that the process started. */
  readonly grantedAtMs: number | null;
  readonly terminal: { readonly exitCode: number | null; readonly signal: string | null; readonly interrupted: boolean | null } | null;
  readonly outputRecorded: boolean;
}
export interface MonitorLedgerAttempt {
  readonly attemptId: string; readonly generation: number;
  /** The Run binding's last projected observation. */
  readonly observedKind: 'started' | 'exited' | 'cancelled' | 'unknown' | null; readonly observedRevision: number | null;
  readonly dispatch: MonitorLedgerDispatch | null;
  /** A `task_evaluation_observations` row exists for (attempt, observed revision): an evaluation was committed (HOLD keeps `evaluating`). */
  readonly evaluationObserved: boolean;
  /** `reserve-run-tasks` receipt `now` that bound this attempt. */
  readonly reservedAtMs: number | null;
  /** `worker_event_logs.record.sealedAt`: the host sealed the worker events at attempt end (native workers only). */
  readonly sealedAtMs: number | null;
  /** MONITOR v1.1 (optional): provider from the evaluation's model record, the frozen profile pin or the dispatch profile adapter; model view from
   * the evaluation record or the pin; first failing line of a failed attempt's recorded output; last worker-reported events (untrusted). */
  readonly provider?: string | null; readonly model?: WorkerModelView | null; readonly firstFailure?: string | null;
  readonly recentEvents?: readonly MonitorEvent[]; readonly diagnostics?: readonly string[];
  /** Host-observed process exit (`worker.log` `exited` event, host clock) of an attempt without a sealed log. */
  readonly observedEndAtMs?: number | null;
}
export interface MonitorEvent { readonly atMs: number | null; readonly kind: string; readonly summary: string }
export interface MonitorLedgerRun {
  readonly capacity?: { readonly executionSlots: number; readonly inFlightSlots: number };
  readonly snapshot: RunSnapshot; readonly poolId: string | null;
  /** Automatic progression intent (`run_execution_intents`, v25+); null when the ledger predates the table. */
  readonly admitted: boolean | null;
  /** `create-run` receipt `now`, else `run_execution_intents.admitted_at`. */
  readonly createdAtMs: number | null;
  readonly attempts: readonly MonitorLedgerAttempt[];
  readonly delivery?: { readonly state: MonitorDeliveryState; readonly commit: string | null } | null;
}
export interface MonitorLedgerApproval {
  readonly scopeId: string; readonly approvalId: string; readonly subjectKind: string; readonly runId: string | null; readonly taskId: string | null;
  readonly summary: string; readonly createdAtMs: number; readonly expiresAtMs: number;
}
export interface MonitorLedgerPool {
  readonly poolId: string; readonly executionSlots: number; readonly inFlightSlots: number; readonly execution: number; readonly inFlight: number;
  /** `execution_pool_holds` (v44); null = never held. `changedBy` is the hold actor's subject. */
  readonly capacity?: { readonly executionSlots: number; readonly inFlightSlots: number };
  readonly hold: { readonly state: 'held' | 'open'; readonly changedAtMs: number; readonly changedBy: string } | null;
}
export interface MonitorLedgerReading {
  readonly ledgerVersion: number; readonly scopeIds: readonly string[]; readonly runs: readonly MonitorLedgerRun[];
  readonly approvals: readonly MonitorLedgerApproval[]; readonly pools: readonly MonitorLedgerPool[];
  /** Typed codes for skipped/corrupt records or version-gated tables (never thrown). */
  readonly diagnostics: readonly string[];
  /** MONITOR v1.1 (optional): what feeds what in the install (config layers, registry, model catalog, policy summary, memory). */
  readonly map?: MonitorMap | null;
}
/** One observed installation: `current` or a configured `next-project` observation source. */
export interface MonitorTarget { readonly id: string; readonly path: string }
export interface MonitorScopeObservation {
  /** The scope `inspect` decision of the target's own policy; only admitted scopes contribute Runs, approvals and workers. */
  readonly access: 'admitted' | 'denied' | 'unavailable';
  readonly workers: readonly WorkerObservation[]; readonly workerStatus: string; readonly truncated: boolean;
  /** The approval list decision (`approval inspect` over the scope); absent or false withholds approval summary text. */
  readonly approvals?: boolean;
}
/** Ports the composition binds to adapters. Every method may reject; the application turns rejections into diagnostics. */
export interface MonitorPorts {
  /** Recorded output and worker events are read only for attempts the adapter's read-output gate admits. */
  readLedger(target: MonitorTarget): Promise<MonitorLedgerReading>;
  /** Rejects with a coded error; `LOCAL_RUNTIME_UNAVAILABLE` means no service is listening. */
  describeService(target: MonitorTarget): Promise<RuntimeServiceDescriptor>;
  observeScope(target: MonitorTarget, scopeId: string): Promise<MonitorScopeObservation>;
  now(): number;
}
