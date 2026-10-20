import type { TaskNotAcceptedReason } from '#domain/index.js';
import type { MonitorAttempt, MonitorBlocker, MonitorBlockerCode, MonitorDeliveryState, MonitorRun, MonitorTask, MonitorWorker } from './contract.js';

/** PARALLEL-S2: human vocabulary only; precise domain/monitor codes and authority remain unchanged. */
export type HumanStateCode = 'queued' | 'running' | 'checking' | 'held' | 'done' | 'stopped';
export type HumanNextAction = 'inspect-run' | 'inspect-worker' | 'inspect-approvals' | 'inspect-pool' | 'inspect-task';
export type HumanState = { readonly state: Exclude<HumanStateCode, 'held'> } | {
  readonly state: 'held'; readonly waitingOn: 'you' | 'operator' | 'system'; readonly reason: MonitorBlockerCode;
  readonly detail: string | null; readonly since: number | null; readonly deadline: number | null; readonly nextAction: HumanNextAction;
};
export type HumanStateSubject = { readonly kind: 'run'; readonly value: MonitorRun }
  | { readonly kind: 'task'; readonly value: MonitorTask; readonly blocker?: MonitorBlocker | null; readonly worker?: MonitorWorker }
  | { readonly kind: 'attempt'; readonly value: MonitorAttempt; readonly worker?: MonitorWorker }
  | { readonly kind: 'worker'; readonly value: MonitorWorker; readonly task?: MonitorTask; readonly blocker?: MonitorBlocker | null }
  | { readonly kind: 'delivery'; readonly value: MonitorDeliveryState };
const plain = (state: Exclude<HumanStateCode, 'held'>): HumanState => Object.freeze({ state });
const held = (reason: MonitorBlockerCode, proof?: MonitorBlocker | null): HumanState => Object.freeze({ state: 'held',
  waitingOn: reason === 'awaiting-approval' || reason === 'awaiting-decision' ? 'you' : reason === 'pool-held' ? 'operator' : 'system', reason,
  detail: proof?.detail ?? null, since: proof?.sinceMs ?? null, deadline: proof?.deadlineMs ?? null,
  nextAction: reason === 'awaiting-approval' ? 'inspect-approvals' : reason === 'pool-held' ? 'inspect-pool'
    : reason === 'awaiting-decision' ? 'inspect-task' : reason === 'worker-stale-heartbeat' || reason === 'worker-silent' ? 'inspect-worker' : 'inspect-run' });
const BLOCKER_STATE: Readonly<Partial<Record<MonitorBlockerCode, Exclude<HumanStateCode, 'held'>>>> = Object.freeze({
  'waiting-dependency': 'queued', 'waiting-scope-conflict': 'queued', 'waiting-pool-slot': 'queued', 'waiting-execution-slot': 'queued', none: 'queued',
  'worker-running': 'running', 'worker-exited-unevaluated': 'checking', 'evaluation-not-ready': 'checking',
});
function blockerState(proof: MonitorBlocker): HumanState {
  const state = BLOCKER_STATE[proof.code]; return state ? plain(state) : held(proof.code, proof);
}
function taskState(task: MonitorTask, proof?: MonitorBlocker | null, worker?: MonitorWorker): HumanState {
  // Terminal outcomes cannot become approval waits because of a stale/unrelated blocker.
  if (task.phase === 'accepted') return plain('done');
  if (['failed', 'cancelled', 'skipped'].includes(task.phase)) return plain('stopped');
  if (task.phase === 'awaiting-decision') return held('awaiting-decision', { code: 'awaiting-decision', taskId: task.taskId,
    sinceMs: task.decision?.sinceMs ?? null, ...(task.decision ? { deadlineMs: task.decision.deadlineMs } : {}), detail: task.decision?.reason ?? null });
  if (task.phase === 'reconciling') return held('unresolved-effect', proof?.taskId === task.taskId ? proof : null);
  if (proof?.taskId === task.taskId) return blockerState(proof);
  if (task.waiting) return blockerState({ code: task.waiting.code, taskId: task.taskId, sinceMs: task.waiting.sinceMs, detail: task.waiting.poolId });
  if (task.phase === 'pending') return plain('queued');
  if (task.phase === 'evaluating') return plain('checking');
  if (task.phase === 'active' && task.lastAttempt) return attemptState(task.lastAttempt, worker);
  return held('unknown');
}
function workerState(worker: MonitorWorker): HumanState {
  if (worker.authority !== 'next-ledger' || !worker.identity) return held('unknown');
  if (worker.terminal) return plain('checking'); // exit alone never proves acceptance or failure of the task.
  if (worker.process === 'created') return plain('queued');
  if (worker.process === 'exited') return plain('checking');
  if (worker.process === 'running' && worker.files?.heartbeat.state === 'available' && worker.files.heartbeat.freshness === 'fresh') return plain('running');
  return held(worker.files?.heartbeat.freshness === 'stale' ? 'worker-stale-heartbeat' : 'unknown');
}
/** PRE-34: the task has since bound a later attempt; this worker's attempt is over (never "checking" forever), unless it still runs. */
const superseded = (worker: MonitorWorker, task: MonitorTask) => !!worker.identity && !!task.lastAttempt
  && task.lastAttempt.attemptId !== worker.identity.attemptId && task.lastAttempt.generation >= worker.identity.generation;
function attemptState(attempt: MonitorAttempt, worker?: MonitorWorker): HumanState {
  if (attempt.endedAtMs !== null) return plain('checking');
  if (worker) return workerState(worker);
  if (attempt.launch === null || attempt.launch === 'pending') return plain('queued');
  return held('unknown'); // a grant or measured heartbeat age alone is not fresh worker custody.
}
/** One pure projection for all monitor subjects. Null hold times mean unproven, never "no deadline". No operation is proposed/admitted. */
export function projectHumanState(subject: HumanStateSubject): HumanState {
  switch (subject.kind) {
    case 'run': {
      const run = subject.value;
      if (['failed', 'cancelled', 'incomplete'].includes(run.state)) return plain('stopped');
      if (run.state === 'parked') {
        // A dependency failure can park a Run; only a real waiting task proves a human decision.
        const decision = run.tasks.find(task => task.phase === 'awaiting-decision' && task.decision);
        return decision ? taskState(decision) : held('parked', run.blocker);
      }
      if (run.state === 'accepted') return run.delivery ? projectHumanState({ kind: 'delivery', value: run.delivery.state }) : plain('done');
      return run.blocker ? blockerState(run.blocker) : held('unknown');
    }
    case 'task': return taskState(subject.value, subject.blocker, subject.worker);
    case 'attempt': return attemptState(subject.value, subject.worker);
    case 'worker': {
      const { value: worker, task } = subject;
      if (task && superseded(worker, task)) return workerState(worker).state === 'running' ? plain('running') : plain('stopped');
      return task ? taskState(task, subject.blocker, worker) : workerState(worker);
    }
    case 'delivery': return plain(subject.value === 'rolled-back' ? 'stopped' : ['integrated', 'delivered', 'adopted'].includes(subject.value) ? 'done' : 'checking');
  }
}

/** PRE-34: why a task stopped, from evidence the snapshot already carries, most specific first; `unrecorded` only when none of it exists. */
export type StopCause = Readonly<{ kind: 'line'; line: string } | { kind: 'tests'; count: number; name: string | null } | { kind: 'not-accepted'; reason: TaskNotAcceptedReason }
  | { kind: 'exit'; code: number } | { kind: 'signal' | 'interrupted' | 'cancelled' | 'skipped' | 'not-launched' | 'no-attempt' | 'output-denied' | 'rejected' | 'rolled-back' | 'unrecorded' }>;
export function projectStopCause(task: MonitorTask): StopCause {
  const attempt = task.lastAttempt, close = attempt?.closeReason;
  if (attempt?.failedTests) return { kind: 'tests', count: attempt.failedTests.count, name: attempt.failedTests.names[0] ?? null };
  if (attempt?.firstFailure) return { kind: 'line', line: attempt.firstFailure };
  if (task.evaluation.reason) return { kind: 'not-accepted', reason: task.evaluation.reason };
  if (task.phase === 'skipped') return { kind: 'skipped' };
  if (task.phase === 'cancelled' || close === 'cancelled') return { kind: 'cancelled' };
  if (!attempt) return { kind: 'no-attempt' };
  if (close === 'signal' || close === 'interrupted') return { kind: close };
  if (attempt.launch === 'prevented-before-launch') return { kind: 'not-launched' };
  if (attempt.exitCode !== null && attempt.exitCode !== 0) return { kind: 'exit', code: attempt.exitCode };
  if (attempt.diagnostics?.includes('output-denied')) return { kind: 'output-denied' };
  return { kind: task.evaluation.verdict === 'rejected' ? 'rejected' : 'unrecorded' };
}
/** The stopped Run's first stopped task and its cause (failed before cancelled/skipped); null unless the Run's human state is `stopped`. */
export function projectRunStop(run: MonitorRun): Readonly<{ taskId: string | null; cause: StopCause }> | null {
  if (projectHumanState({ kind: 'run', value: run }).state !== 'stopped') return null;
  if (run.state === 'accepted') return { taskId: null, cause: { kind: 'rolled-back' } };
  const task = run.tasks.find(value => value.phase === 'failed' || value.evaluation.verdict === 'rejected')
    ?? run.tasks.find(value => value.phase === 'cancelled' || value.phase === 'skipped');
  return task ? { taskId: task.taskId, cause: projectStopCause(task) } : { taskId: null, cause: { kind: run.state === 'cancelled' ? 'cancelled' : 'unrecorded' } };
}
