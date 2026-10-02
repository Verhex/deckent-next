import { inspectTaskReadiness, type TaskReadiness, type WorkerModelView } from '#domain/index.js';
import type { WorkerObservation } from '#engine/core/worker-observation/index.js';
import type { MonitorBlocker, MonitorBlockerCode, MonitorRun, MonitorRunState, MonitorTask } from './contract.js';
import type { MonitorLedgerApproval, MonitorLedgerAttempt, MonitorLedgerPool, MonitorLedgerRun } from './evidence.js';

/** Everything the pure derivation reads about one Run; `observedAt` is the snapshot's sampling time (host clock). */
export interface MonitorRunEvidence {
  readonly run: MonitorLedgerRun; readonly approvals: readonly MonitorLedgerApproval[]; readonly pool: MonitorLedgerPool | null;
  readonly workers: ReadonlyMap<string, WorkerObservation>; readonly observedAt: number;
}
/**
 * The one blocker precedence (MONITOR-DATA): repair/human conditions outrank progress; equal codes keep graph order. `unknown` (no
 * evidence) sits above the progressing codes so missing evidence is never shown as healthy progress.
 */
export const MONITOR_BLOCKER_PRECEDENCE: readonly MonitorBlockerCode[] = Object.freeze(['parked', 'awaiting-decision', 'cancellation-pending', 'unresolved-effect', 'evaluation-unknown',
  'evaluation-not-ready', 'worker-stale-heartbeat', 'worker-exited-unevaluated', 'awaiting-approval', 'not-admitted', 'pool-held', 'waiting-pool-slot',
  'unknown', 'worker-running', 'none', 'waiting-dependency']);
const STATE: Readonly<Record<MonitorBlockerCode, MonitorRunState>> = Object.freeze({ parked: 'parked', 'awaiting-decision': 'waiting', 'none': 'progressing', 'worker-running': 'progressing',
  'waiting-pool-slot': 'waiting', 'pool-held': 'waiting', 'awaiting-approval': 'waiting', 'cancellation-pending': 'waiting', 'worker-exited-unevaluated': 'waiting',
  'waiting-dependency': 'waiting', 'worker-stale-heartbeat': 'blocked', 'evaluation-not-ready': 'blocked', 'evaluation-unknown': 'blocked',
  'unresolved-effect': 'blocked', 'not-admitted': 'blocked', 'unknown': 'blocked' });
const OPEN = new Set(['pending', 'active', 'evaluating', 'reconciling', 'awaiting-decision']);
const blocker = (code: MonitorBlockerCode, taskId: string | null, sinceMs: number | null = null, detail: string | null = null): MonitorBlocker =>
  Object.freeze({ code, taskId, sinceMs, detail });
const readiness = (run: MonitorLedgerRun, now: number) => new Map(inspectTaskReadiness(run.snapshot.graph,
  { graphRevision: run.snapshot.graph.revision, now, progress: run.snapshot.progress }).map(entry => [entry.taskId, entry]));
const attemptOf = (run: MonitorLedgerRun, taskId: string) => {
  const binding = run.snapshot.bindings.find(value => value.identity.taskId === taskId);
  return binding ? run.attempts.find(value => value.attemptId === binding.identity.attemptId) ?? null : null;
};
/** Last heartbeat time proven by the sidecar: the sampling time minus its measured age; null without an age. */
/** The proven end of an attempt: its sealed worker log, else the host-observed exit; never the launch grant. */
const endOf = (attempt: MonitorLedgerAttempt | null | undefined) => attempt?.sealedAtMs ?? attempt?.observedEndAtMs ?? null;
const heartbeatAt = (worker: WorkerObservation | undefined, observedAt: number) => {
  const age = worker?.files?.heartbeat.ageMs; return typeof age === 'number' ? observedAt - age : null;
};

function boundBlocker(taskId: string, phase: string, attempt: MonitorLedgerAttempt | null, worker: WorkerObservation | undefined, e: MonitorRunEvidence): MonitorBlocker {
  const dispatch = attempt?.dispatch ?? null, terminal = dispatch?.terminal ?? null;
  if (phase === 'evaluating') {
    if (attempt?.evaluationObserved) return blocker('evaluation-unknown', taskId);
    if (!terminal) return blocker('evaluation-not-ready', taskId, null, 'terminal-missing');
    if (terminal.interrupted === true) return blocker('evaluation-not-ready', taskId, endOf(attempt), 'interrupted');
    if (!dispatch?.outputRecorded) return blocker('evaluation-not-ready', taskId, endOf(attempt), 'output-missing');
    return blocker('worker-exited-unevaluated', taskId, endOf(attempt));
  }
  if (!attempt) return blocker('unknown', taskId, null, 'attempt-missing');
  if (!dispatch) return e.run.admitted === false ? blocker('not-admitted', taskId, e.run.createdAtMs) : blocker('none', taskId, attempt.reservedAtMs, 'dispatch-pending');
  if (dispatch.launch === 'pending') return blocker('none', taskId, attempt.reservedAtMs, 'launch-pending');
  if (dispatch.launch === 'prevented-before-launch') return blocker('cancellation-pending', taskId);
  if (terminal) return blocker('worker-exited-unevaluated', taskId, endOf(attempt), 'projection-pending');
  if (!worker) return blocker('unknown', taskId, null, 'worker-unobserved');
  // Observed without sidecars (output denied by policy, observation unavailable): no heartbeat was read, so neither running nor stale.
  if (!worker.files) return blocker('unknown', taskId, null, worker.diagnostics[0] ?? 'sidecars-missing');
  const freshness = worker.files.heartbeat.freshness;
  if (freshness === 'fresh' && !['exited', 'missing'].includes(worker.process)) return blocker('worker-running', taskId, dispatch.grantedAtMs, worker.files.activity?.phase ?? null);
  return blocker('worker-stale-heartbeat', taskId, heartbeatAt(worker, e.observedAt), freshness === 'fresh' ? 'process-' + worker.process : freshness);
}
function pendingBlocker(task: TaskReadiness, e: MonitorRunEvidence): MonitorBlocker {
  const id = task.taskId;
  if (task.disposition === 'waiting' || task.disposition === 'blocked') return blocker('waiting-dependency', id, null, task.dependencies[0] ?? null);
  if (task.disposition === 'delayed') return blocker('none', id, null, 'not-before');
  const approval = e.approvals.find(value => value.subjectKind === 'task' && value.runId === e.run.snapshot.identity.runId && value.taskId === id
    && value.scopeId === e.run.snapshot.identity.scopeId);
  if (approval) return blocker('awaiting-approval', id, approval.createdAtMs, approval.approvalId);
  if (e.run.admitted === false) return blocker('not-admitted', id, e.run.createdAtMs);
  const pool = e.pool;
  if (pool?.hold?.state === 'held') return blocker('pool-held', id, pool.hold.changedAtMs, pool.poolId);
  if (pool && (pool.execution >= pool.executionSlots || pool.inFlight >= pool.inFlightSlots)) return blocker('waiting-pool-slot', id, null, pool.poolId);
  return blocker('none', id, null, 'reservation-pending');
}
/** One blocker per non-terminal Run (null when every task is terminal), chosen by `MONITOR_BLOCKER_PRECEDENCE`. */
export function deriveRunBlocker(e: MonitorRunEvidence): MonitorBlocker | null {
  const snapshot = e.run.snapshot;
  if (snapshot.state.kind === 'terminal') return null;
  if (snapshot.state.kind === 'parked') return blocker('parked', null, snapshot.state.since, snapshot.state.reason);
  if (!snapshot.progress.some(task => OPEN.has(task.phase))) return null;
  if (snapshot.cancelRequested) return blocker('cancellation-pending', null);
  const ready = readiness(e.run, e.observedAt); const candidates: MonitorBlocker[] = [];
  for (const definition of snapshot.graph.tasks) {
    const task = snapshot.progress.find(value => value.taskId === definition.id)!;
    const attempt = attemptOf(e.run, task.taskId);
    if (task.unresolvedEffects || task.phase === 'reconciling') candidates.push(blocker('unresolved-effect', task.taskId, null, attempt?.observedKind ?? null));
    else if (task.phase === 'active' || task.phase === 'evaluating') candidates.push(boundBlocker(task.taskId, task.phase, attempt, attempt ? e.workers.get(attempt.attemptId) : undefined, e));
    else if (task.phase === 'awaiting-decision') candidates.push(blocker('awaiting-decision', task.taskId, task.decision!.since, task.decision!.reason));
    else if (task.phase === 'pending') candidates.push(pendingBlocker(ready.get(task.taskId)!, e));
  }
  const rank = (value: MonitorBlocker) => MONITOR_BLOCKER_PRECEDENCE.indexOf(value.code);
  return candidates.reduce((best, value) => rank(value) < rank(best) ? value : best);
}
/** Terminal Runs by their task outcomes (failed › cancelled › accepted); otherwise the blocker's state, where a dependency that can no
 * longer be accepted (failed/cancelled) blocks instead of waits. */
export function deriveRunState(e: MonitorRunEvidence, current: MonitorBlocker | null): MonitorRunState {
  const state = e.run.snapshot.state;
  if (state.kind === 'parked') return 'parked';
  if (state.kind === 'terminal') return state.outcome === 'completed' ? 'accepted' : state.outcome;
  const phases = e.run.snapshot.progress.map(task => task.phase);
  if (!current) return phases.includes('failed') ? 'failed' : phases.includes('cancelled') ? 'cancelled' : 'accepted';
  if (current.code === 'waiting-dependency' && current.taskId && readiness(e.run, e.observedAt).get(current.taskId)?.disposition === 'blocked') return 'blocked';
  return STATE[current.code];
}
/** The model a worker ran: the sealed usage, else its init, else the requested pin (named honestly: a pin is what was asked for). */
const modelName = (view: WorkerModelView | null | undefined) => view ? view.usage?.[0] ?? view.init ?? view.requested.modelId : null;
function verdict(phase: string, attempt: MonitorLedgerAttempt | null): MonitorTask['evaluation']['verdict'] {
  if (phase === 'accepted') return 'accepted';
  if (phase === 'failed') return attempt?.evaluationObserved ? 'rejected' : null;
  if (phase === 'awaiting-decision') return 'unknown';
  if (phase === 'evaluating') return attempt?.evaluationObserved ? 'unknown' : 'pending';
  return null;
}
/** The surface value of one Run: tasks with their bound attempt joined to its worker observation, one blocker, state and latest proof. */
export function projectMonitorRun(e: MonitorRunEvidence): MonitorRun {
  const snapshot = e.run.snapshot; const phaseCounts: Record<string, number> = {}; const times: number[] = [];
  const push = (...values: (number | null | undefined)[]) => { for (const value of values) if (typeof value === 'number') times.push(value); };
  push(e.run.createdAtMs);
  const tasks = snapshot.graph.tasks.map((definition): MonitorTask => {
    const progress = snapshot.progress.find(value => value.taskId === definition.id)!; const attempt = attemptOf(e.run, definition.id);
    const worker = attempt ? e.workers.get(attempt.attemptId) : undefined; const profile = snapshot.execution.tasks.find(value => value.taskId === definition.id)?.profile;
    phaseCounts[progress.phase] = (phaseCounts[progress.phase] ?? 0) + 1;
    push(attempt?.reservedAtMs, attempt?.dispatch?.grantedAtMs, endOf(attempt), heartbeatAt(worker, e.observedAt), worker?.files?.activity?.receivedAt);
    const provider = worker && worker.provider !== 'unknown' ? worker.provider : attempt?.provider ?? null;
    return Object.freeze({ taskId: definition.id, kind: definition.kind, phase: progress.phase, profile: profile ? { id: profile.id, version: profile.version } : null,
      attempts: attempt ? 1 : 0, dependencies: definition.dependencies, evaluation: { verdict: progress.acceptedEvidence === 'model-unverified' ? 'accepted-unverified' : verdict(progress.phase, attempt), observedAtMs: null },
      lastAttempt: attempt ? Object.freeze({ attemptId: attempt.attemptId, generation: attempt.generation, launch: attempt.dispatch?.launch ?? null,
        exitCode: attempt.dispatch?.terminal?.exitCode ?? null, startedAtMs: attempt.dispatch?.grantedAtMs ?? null, endedAtMs: endOf(attempt),
        endedAtSource: attempt.sealedAtMs !== null ? 'sealed' as const : endOf(attempt) !== null ? 'observed' as const : null,
        workerPhase: worker?.files?.activity?.phase ?? null, heartbeatAgeMs: worker?.files?.heartbeat.ageMs ?? null, provider,
        model: modelName(worker?.model ?? attempt.model), firstFailure: attempt.firstFailure ?? null, ...(attempt.recentEvents ? { recentEvents: attempt.recentEvents } : {}),
        ...(attempt.diagnostics ? { diagnostics: attempt.diagnostics } : {}) }) : null });
  });
  const current = deriveRunBlocker(e);
  // Proven finish of a terminal Run: every bound attempt has a proven end (sealed or host-observed); the latest of them.
  const ends = snapshot.bindings.map(binding => endOf(e.run.attempts.find(value => value.attemptId === binding.identity.attemptId)));
  const finishedAtMs = !current && ends.length && ends.every(value => value !== null) ? Math.max(...ends as number[]) : null;
  return Object.freeze({ scopeId: snapshot.identity.scopeId, runId: snapshot.identity.runId, revision: snapshot.revision, state: deriveRunState(e, current),
    phaseCounts: Object.freeze(phaseCounts), tasks: Object.freeze(tasks), blocker: current, cancellationRequested: snapshot.cancelRequested,
    lastActivityMs: times.length ? Math.max(...times) : null, createdAtMs: e.run.createdAtMs, finishedAtMs, delivery: e.run.delivery ?? null });
}
