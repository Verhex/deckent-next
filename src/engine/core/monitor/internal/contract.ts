import type { WorkerObservation } from '#engine/core/worker-observation/index.js';

/**
 * MONITOR (owner 2026-10-02, Jev 47725dae): the one read-only snapshot a human monitors Deckent from — every observed install
 * (the current project plus configured `next-project` observation sources), its build and service, every Run of every scope with
 * per-task phase/attempt/age, ONE derived blocker per non-terminal Run, workers, approvals waiting for a human and pool capacity.
 * Observe-only: building it never writes, claims, reserves or decides. CLI `--json`, the human text and the fullscreen monitor all
 * render this same value; the blocker is derived once (engine) and never re-derived by a surface.
 */
export type MonitorInstallStatus = 'available' | 'unavailable' | 'denied';
export interface MonitorBuild { readonly sourceCommit: string | null; readonly sourceTreeSha256: string | null; readonly builtAt: string | null }
export interface MonitorService {
  readonly state: 'running' | 'stopped' | 'unknown'; readonly instanceId: string | null; readonly processId: number | null;
  readonly build: MonitorBuild | null;
}
/** Why a non-terminal Run is not progressing; `none` only when it is progressing normally. */
export type MonitorBlockerCode = 'none' | 'waiting-pool-slot' | 'pool-held' | 'waiting-dependency' | 'awaiting-approval'
  | 'worker-running' | 'worker-stale-heartbeat' | 'worker-exited-unevaluated' | 'evaluation-not-ready' | 'evaluation-unknown'
  | 'unresolved-effect' | 'cancellation-pending' | 'not-admitted' | 'unknown';
export interface MonitorBlocker {
  readonly code: MonitorBlockerCode; readonly taskId: string | null;
  /** Epoch ms since when this condition holds, when the ledger or sidecars prove it; null when unknown (never guessed). */
  readonly sinceMs: number | null;
  /** Short typed detail (e.g. an error code, pool id, approval id); human wording lives in the i18n catalogs. */
  readonly detail: string | null;
}
export interface MonitorAttempt {
  readonly attemptId: string; readonly generation: number; readonly launch: string | null; readonly exitCode: number | null;
  readonly startedAtMs: number | null; readonly endedAtMs: number | null;
  /** Live worker phase from the worker-event contract (starting/thinking/reading/editing/running/…), null without events. */
  readonly workerPhase: string | null; readonly heartbeatAgeMs: number | null; readonly provider: string | null;
}
export interface MonitorTask {
  readonly taskId: string; readonly kind: string; readonly phase: string;
  readonly profile: { readonly id: string; readonly version: number } | null;
  readonly attempts: number; readonly lastAttempt: MonitorAttempt | null;
  readonly evaluation: { readonly verdict: 'accepted' | 'rejected' | 'unknown' | 'pending' | null; readonly observedAtMs: number | null };
  readonly dependencies: readonly string[];
}
export type MonitorRunState = 'progressing' | 'waiting' | 'blocked' | 'accepted' | 'failed' | 'cancelled';
export interface MonitorRun {
  readonly scopeId: string; readonly runId: string; readonly revision: number; readonly state: MonitorRunState;
  readonly phaseCounts: Readonly<Record<string, number>>; readonly tasks: readonly MonitorTask[];
  readonly blocker: MonitorBlocker | null; readonly cancellationRequested: boolean;
  /** Latest proven activity time of the Run (attempt start/end, evaluation, heartbeat); null when no evidence. */
  readonly lastActivityMs: number | null;
  /** MONITOR-DATA (optional, additive): admission time from the create-run receipt `now` or `run_execution_intents.admitted_at`. */
  readonly createdAtMs?: number | null;
}
export interface MonitorApproval {
  readonly scopeId: string; readonly approvalId: string; readonly subjectKind: string; readonly summary: string;
  readonly requiredAssurance: string | null; readonly createdAtMs: number | null; readonly expiresAtMs: number | null;
}
export interface MonitorPool {
  readonly poolId: string; readonly capacity: number | null; readonly inFlight: number; readonly held: boolean; readonly heldBy: string | null;
  /** MONITOR-DATA (optional, additive): the pool's second limit. `capacity`/`inFlight` are in-flight slots/occupancy (active, evaluating,
   * uncertain); these are execution slots/occupancy (active, uncertain). A reservation needs both, so either can cause `waiting-pool-slot`. */
  readonly executionCapacity?: number | null; readonly executing?: number;
}
export interface MonitorInstall {
  /** `current` for the project the command runs in, else the observation source id. */
  readonly id: string; readonly path: string; readonly status: MonitorInstallStatus; readonly scopeIds: readonly string[];
  readonly service: MonitorService | null; readonly ledgerVersion: number | null;
  readonly runs: readonly MonitorRun[]; readonly workers: readonly WorkerObservation[];
  readonly approvals: readonly MonitorApproval[]; readonly pools: readonly MonitorPool[];
  /** Typed codes for what could not be read (never thrown to the surface); rendered as a visible warning. */
  readonly diagnostics: readonly string[];
}
export interface MonitorSnapshot {
  readonly schemaVersion: 1; readonly observedAt: number; readonly installs: readonly MonitorInstall[]; readonly control: 'observe-only';
}
