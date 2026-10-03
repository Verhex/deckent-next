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
export type MonitorBlockerCode = 'parked' | 'awaiting-decision' | 'none' | 'waiting-pool-slot' | 'waiting-execution-slot' | 'pool-held' | 'waiting-dependency' | 'awaiting-approval'
  | 'worker-running' | 'worker-stale-heartbeat' | 'worker-exited-unevaluated' | 'evaluation-not-ready' | 'evaluation-unknown'
  | 'unresolved-effect' | 'cancellation-pending' | 'not-admitted' | 'unknown';
export interface MonitorBlocker {
  readonly pool?: import('#engine/core/runs/index.js').PoolWait;
  readonly code: MonitorBlockerCode; readonly taskId: string | null;
  /** Epoch ms since when this condition holds, when the ledger or sidecars prove it; null when unknown (never guessed). */
  readonly sinceMs: number | null;
  /** Short typed detail (e.g. an error code, pool id, approval id); human wording lives in the i18n catalogs. */
  readonly detail: string | null;
  /** Durable park/decision deadline, when this blocker is bounded by one. */
  readonly deadlineMs?: number;
}
export interface MonitorAttempt {
  readonly attemptId: string; readonly generation: number; readonly launch: string | null; readonly exitCode: number | null;
  readonly startedAtMs: number | null; readonly endedAtMs: number | null;
  /** MONITOR-DATA (optional): what proves `endedAtMs` — `sealed` (the host sealed the worker event log) or `observed` (the host's own exit
   * observation in the attempt's `worker.log` sidecar); null when no end is proven. The ledger records no evaluation time. */
  readonly endedAtSource?: 'sealed' | 'observed' | null;
  /** Live worker phase from the worker-event contract (starting/thinking/reading/editing/running/…), null without events. */
  readonly workerPhase: string | null; readonly heartbeatAgeMs: number | null; readonly provider: string | null;
  /** MONITOR v1.1: exact model the worker ran (sealed model view or pin), first failing line of a failed attempt's recorded output
   * (e.g. a lint-arch violation or the first failing test), and the last worker-reported events (untrusted, bounded). */
  readonly model?: string | null; readonly firstFailure?: string | null;
  readonly recentEvents?: readonly { readonly atMs: number | null; readonly kind: string; readonly summary: string }[];
  /** MONITOR-DATA (optional): why recorded content is absent, e.g. `output-denied` (no attempt read-output decision: nothing was read). */
  readonly diagnostics?: readonly string[];
}
export interface MonitorTask {
  readonly waiting?: import('#engine/core/runs/index.js').PoolWait;
  readonly decision?: { readonly reason: 'evaluation-unknown' | 'evaluation-not-ready'; readonly sinceMs: number; readonly deadlineMs: number };
  readonly taskId: string; readonly kind: string; readonly phase: string;
  readonly profile: { readonly id: string; readonly version: number } | null;
  readonly attempts: number; readonly lastAttempt: MonitorAttempt | null;
  readonly evaluation: { readonly verdict: 'accepted' | 'accepted-unverified' | 'rejected' | 'unknown' | 'pending' | null; readonly observedAtMs: number | null };
  readonly dependencies: readonly string[];
}
export type MonitorRunState = 'progressing' | 'waiting' | 'blocked' | 'accepted' | 'failed' | 'cancelled' | 'parked' | 'incomplete';
export interface MonitorRun {
  readonly scopeId: string; readonly runId: string; readonly revision: number; readonly state: MonitorRunState;
  readonly phaseCounts: Readonly<Record<string, number>>; readonly tasks: readonly MonitorTask[];
  readonly blocker: MonitorBlocker | null; readonly cancellationRequested: boolean;
  /** Latest proven activity time of the Run (attempt start/end, evaluation, heartbeat); null when no evidence. */
  readonly lastActivityMs: number | null;
  /** MONITOR-DATA (optional, additive): admission time from the create-run receipt `now` or `run_execution_intents.admitted_at`. */
  readonly createdAtMs?: number | null;
  /** MONITOR v1.1 (optional): a terminal Run's latest proven attempt end (sealed worker log), null when any end is unproven; and its delivery
   * from the ledger's integration → delivery → adoption records (the furthest proven step; `commit` is the delivered/adopted commit). */
  readonly finishedAtMs?: number | null;
  readonly delivery?: { readonly state: MonitorDeliveryState; readonly commit: string | null } | null;
}
export type MonitorDeliveryState = 'integrating' | 'integrated' | 'delivering' | 'delivered' | 'adopting' | 'adopted' | 'rolling-back' | 'rolled-back';
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
  /** Typed codes for what could not be read (never thrown to the surface); rendered as a visible warning. MONITOR v1.1 convention
   * (additive): a code starting with `info:` is informational (a bound, a cap, an older ledger, ledger-only facts) and not a problem;
   * every other code is a problem. Worker observations use the same prefix in their own diagnostics (e.g. `info:ledger-only`). */
  readonly diagnostics: readonly string[];
  /** MONITOR v1.1 map: what feeds what in this install — config layers, execution registry, model catalog, policy, memory. */
  readonly map?: MonitorMap | null;
}
export interface MonitorMap {
  /** Config layers in precedence order with the top-level sections each one actually sets (no values: secrets never appear). */
  readonly config: readonly { readonly layer: 'default' | 'global' | 'project' | 'environment'; readonly path: string | null; readonly sections: readonly string[] }[];
  readonly registry: { readonly profiles: readonly { readonly id: string; readonly version: number; readonly adapter: string }[];
    readonly kinds: readonly { readonly kind: string; readonly profile: string }[] };
  readonly models: readonly { readonly channelId: string; readonly modelId: string; readonly active: boolean; readonly vendorId?: string | null; readonly billing?: 'subscription' | 'per-token' | 'self-hosted' | null }[];
  readonly policy: { readonly grants: number; readonly byResourceKind: Readonly<Record<string, number>>; readonly separationOfDuties: number;
    readonly permissionModes: readonly { readonly principal: string; readonly mode: string }[] } | null;
  /** Next has no memory subsystem yet: always `{ available: false }` until the MEMORY card lands — shown honestly, never invented. */
  readonly memory: { readonly available: boolean };
}
export interface MonitorSnapshot {
  readonly schemaVersion: 1; readonly observedAt: number; readonly installs: readonly MonitorInstall[]; readonly control: 'observe-only';
}
