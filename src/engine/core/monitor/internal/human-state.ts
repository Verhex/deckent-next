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
    : reason === 'awaiting-decision' ? 'inspect-task' : reason === 'worker-stale-heartbeat' ? 'inspect-worker' : 'inspect-run' });
const BLOCKER_STATE: Readonly<Partial<Record<MonitorBlockerCode, Exclude<HumanStateCode, 'held'>>>> = Object.freeze({
  'waiting-dependency': 'queued', 'waiting-pool-slot': 'queued', 'waiting-execution-slot': 'queued', none: 'queued',
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
    case 'worker': return subject.task ? taskState(subject.task, subject.blocker, subject.value) : workerState(subject.value);
    case 'delivery': return plain(subject.value === 'rolled-back' ? 'stopped' : ['integrated', 'delivered', 'adopted'].includes(subject.value) ? 'done' : 'checking');
  }
}
