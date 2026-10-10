import { counterSchema } from '#domain/core/primitives/index.js';
import { inspectTaskReadiness, taskDependencyIds, type TaskProgress } from '#domain/core/task-graph/index.js';
import { checkedRun, runSnapshotSchema, RunError, type RunSnapshot } from './contract.js';
export type RunLifecycleTiming = Readonly<{ now: number; timeoutMs: number }>;
export type TaskDecisionReason = 'evaluation-unknown' | 'evaluation-not-ready';
function deadlineAt(now: number, timeoutMs: number) {
  counterSchema.parse(now); counterSchema.positive().parse(timeoutMs);
  return counterSchema.parse(now + timeoutMs);
}
/** One pure owner of dependency closure and park/terminal classification. Never settles uncertain effects. */
export function reconcileRunLifecycle(input: unknown, now: number, timeoutMs: number): RunSnapshot {
  const run = runSnapshotSchema.parse(input); deadlineAt(now, timeoutMs);
  if (run.state.kind === 'terminal') return run;
  const progress = new Map(run.progress.map(task => [task.taskId, task]));
  let changed: boolean;
  do {
    changed = false;
    for (const task of run.graph.tasks) {
      const state = progress.get(task.id)!;
      if (state.phase !== 'pending') continue;
      const unavailable = taskDependencyIds(task).map(id => progress.get(id)!).find(parent => ['failed', 'cancelled', 'skipped'].includes(parent.phase));
      if (!unavailable) continue;
      const skippedReason = unavailable.phase === 'skipped' ? unavailable.skippedReason! : unavailable.phase === 'cancelled' ? 'dependency-cancelled' : 'dependency-failed';
      progress.set(task.id, { ...state, phase: 'skipped', skippedReason }); changed = true;
    }
  } while (changed);
  const tasks = run.progress.map(task => progress.get(task.taskId)!);
  const readiness = inspectTaskReadiness(run.graph, { graphRevision: run.graph.revision, now, progress: tasks });
  let state: RunSnapshot['state'];
  if (tasks.every(task => task.phase === 'accepted')) state = { kind: 'terminal', outcome: 'completed', reason: 'completed' };
  else if (!run.cancelRequested && run.state.kind === 'parked' && run.state.reason === 'operator-hold') state = run.state;
  else if (!run.cancelRequested && tasks.some(task => task.decision?.reason === 'needs-input')) {
    const decision = tasks.find(task => task.decision?.reason === 'needs-input')!.decision!;
    state = { kind: 'parked', reason: 'needs-input', since: decision.since, deadline: decision.deadline };
  }
  else if (tasks.some(task => task.unresolvedEffects || ['active', 'evaluating', 'reconciling'].includes(task.phase)) || readiness.some(task => ['ready', 'delayed'].includes(task.disposition))) state = { kind: 'running' };
  else if (run.cancelRequested && !tasks.some(task => task.phase === 'awaiting-decision')) state = { kind: 'terminal', outcome: tasks.some(task => task.phase === 'accepted') ? 'incomplete' : 'cancelled', reason: 'cancelled' };
  else {
    const waiting = tasks.find(task => task.phase === 'awaiting-decision');
    const reason = waiting ? waiting.decision!.reason === 'evaluation-not-ready' ? 'evaluation-not-ready' : 'awaiting-decision'
      : tasks.some(task => task.phase === 'failed' || task.skippedReason === 'dependency-failed') ? 'dependency-failed' : 'dependency-cancelled';
    state = run.state.kind === 'parked' ? { ...run.state, reason } : { kind: 'parked', reason, since: now, deadline: deadlineAt(now, timeoutMs) };
  }
  return runSnapshotSchema.parse({ ...run, progress: tasks, state });
}
function incrementIfChanged(run: RunSnapshot, next: RunSnapshot) {
  return JSON.stringify(run) === JSON.stringify(next) ? run : runSnapshotSchema.parse({ ...next, revision: run.revision + 1 });
}
export function advanceRunLifecycle(input: unknown, expectedRevision: number, now: number, timeoutMs: number): RunSnapshot {
  const run = checkedRun(input, expectedRevision); deadlineAt(now, timeoutMs);
  if (run.state.kind === 'terminal') return run;
  const expired = run.progress.some(task => task.decision && task.decision.deadline <= now);
  const progress = run.progress.map(task => {
    if (run.state.kind === 'parked' && ['operator-hold', 'needs-input'].includes(run.state.reason) && run.state.deadline <= now && task.phase === 'pending') return { ...task, phase: 'cancelled' as const };
    if (!task.decision || (task.decision.deadline > now && !(run.state.kind === 'parked' && run.state.deadline <= now))) return task;
    return { ...task, decision: undefined, phase: 'failed' as const };
  });
  const dueHold = run.state.kind === 'parked' && run.state.reason === 'operator-hold' && run.state.deadline <= now;
  const live = progress.some(task => task.unresolvedEffects || ['active', 'evaluating', 'reconciling'].includes(task.phase));
  let next = reconcileRunLifecycle({ ...run, progress, ...(dueHold && !live ? { state: { kind: 'running' } } : {}) }, now, timeoutMs);
  if ((run.state.kind === 'parked' && run.state.deadline <= now) || (expired && next.state.kind === 'parked')) {
    // A Run with live work or uncertain effects remains under execution/reconciliation custody.
    if (next.state.kind === 'parked' && !live) next = runSnapshotSchema.parse({ ...next, state: { kind: 'terminal', outcome: next.progress.some(task => task.phase === 'accepted') ? 'incomplete' : 'failed', reason: 'park-timeout' } });
  }
  return incrementIfChanged(run, next);
}
export const expireParkedRun = advanceRunLifecycle;
export function closeParkedRun(input: unknown, expectedRevision: number, now: number, timeoutMs: number): RunSnapshot {
  const run = checkedRun(input, expectedRevision); counterSchema.parse(now);
  if (run.state.kind !== 'parked') throw new RunError('RUN_NOT_PARKED');
  if (run.progress.some(task => task.unresolvedEffects || ['active', 'evaluating', 'reconciling'].includes(task.phase))) throw new RunError('RUN_DECISION_NOT_READY');
  const progress = run.progress.map(task => {
    if (task.phase === 'pending') return { ...task, phase: 'cancelled' as const };
    if (task.phase !== 'awaiting-decision') return task;
    return { ...task, decision: undefined, phase: 'failed' as const };
  });
  const next = reconcileRunLifecycle({ ...run, progress }, now, timeoutMs);
  return runSnapshotSchema.parse({ ...next, revision: run.revision + 1, state: { kind: 'terminal', outcome: next.progress.some(task => task.phase === 'accepted') ? 'incomplete' : 'failed', reason: 'operator-close' } });
}
export function resumeParkedRun(input: unknown, expectedRevision: number, now: number, timeoutMs: number): RunSnapshot {
  const run = checkedRun(input, expectedRevision);
  if (run.state.kind !== 'parked') throw new RunError('RUN_NOT_PARKED');
  if (run.state.reason === 'operator-hold' && run.state.deadline > now) {
    return reconcileRunLifecycle({ ...run, revision: run.revision + 1, state: { kind: 'running' } }, now, timeoutMs);
  }
  // Dependency/decision barriers survive resume; neither reset deadlines nor revive never-run work.
  return advanceRunLifecycle(run, expectedRevision, now, timeoutMs);
}
export function parkTaskAwaitingDecision(input: unknown, expectedRevision: number, taskId: string, reason: TaskDecisionReason, now: number, timeoutMs: number, evaluationId?: string, evidenceDigests?: readonly string[]): RunSnapshot {
  const run = checkedRun(input, expectedRevision); const task = run.progress.find(value => value.taskId === taskId);
  if (!task || task.phase !== 'evaluating' || task.unresolvedEffects || run.cancelRequested || run.state.kind === 'terminal') throw new RunError('RUN_DECISION_NOT_READY');
  const decision = { reason, since: now, deadline: deadlineAt(now, timeoutMs), ...(evaluationId === undefined ? {} : { evaluationId }), ...(evidenceDigests ? { evidenceDigests } : {}) };
  return reconcileRunLifecycle({ ...run, revision: run.revision + 1, progress: run.progress.map(value => value === task ? { ...value, phase: 'awaiting-decision', decision } : value) }, now, timeoutMs);
}
/** Application must authorize a HUMAN principal and persist its immutable decision audit in the same transaction. */
export function resolveTaskDecision(input: unknown, expectedRevision: number, taskId: string, decision: 'accept' | 'reject', now: number, timeoutMs: number): RunSnapshot {
  const run = checkedRun(input, expectedRevision); const task = run.progress.find(value => value.taskId === taskId); deadlineAt(now, timeoutMs);
  if (!task || task.phase !== 'awaiting-decision' || !task.decision || task.unresolvedEffects || run.cancelRequested || run.state.kind === 'terminal') throw new RunError('RUN_DECISION_NOT_READY');
  if (task.decision.deadline <= now || (run.state.kind === 'parked' && run.state.deadline <= now)) throw new RunError('RUN_DECISION_EXPIRED');
  if (decision !== 'accept' && decision !== 'reject') throw new RunError('RUN_DECISION_NOT_READY');
  if (decision === 'accept' && ['evaluation-not-ready', 'needs-input'].includes(task.decision.reason)) throw new RunError('RUN_DECISION_NOT_READY');
  const rest = { ...task, decision: undefined };
  const resolved: TaskProgress = decision === 'accept' ? { ...rest, phase: 'accepted', acceptedEvidence: 'model-unverified' } : { ...rest, phase: 'failed' };
  return reconcileRunLifecycle({ ...run, revision: run.revision + 1, progress: run.progress.map(value => value === task ? resolved : value) }, now, timeoutMs);
}

/** Stop new reservations without claiming that existing execution/effects stopped. */
export function holdRun(input: unknown, expectedRevision: number, note: string, now: number, timeoutMs: number): RunSnapshot {
  const run = checkedRun(input, expectedRevision);
  if (run.cancelRequested || run.state.kind === 'terminal') throw new RunError('RUN_TERMINAL');
  if (run.state.kind === 'parked' && run.state.reason === 'operator-hold') throw new RunError('RUN_PARKED');
  const timing = run.state.kind === 'parked' ? run.state : { since: now, deadline: deadlineAt(now, timeoutMs) };
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1, state: { kind: 'parked', reason: 'operator-hold', note, since: timing.since, deadline: timing.deadline } });
}

/** An answer creates eligibility for a NEW attempt. The old attempt and its receipts remain immutable. */
export function answerTaskInput(input: unknown, expectedRevision: number, taskId: string, answer: string, now: number, timeoutMs: number): RunSnapshot {
  const run = checkedRun(input, expectedRevision), task = run.progress.find(value => value.taskId === taskId);
  const binding = run.bindings.find(value => value.identity.taskId === taskId);
  if (!task || task.phase !== 'awaiting-decision' || task.decision?.reason !== 'needs-input' || !binding
    || binding.observedKind !== 'exited' || task.unresolvedEffects || run.cancelRequested || run.state.kind === 'terminal') throw new RunError('RUN_DECISION_NOT_READY');
  if (task.decision.deadline <= now || (run.state.kind === 'parked' && run.state.deadline <= now)) throw new RunError('RUN_DECISION_EXPIRED');
  return reconcileRunLifecycle({ ...run, revision: run.revision + 1,
    state: run.state.kind === 'parked' && run.state.reason === 'operator-hold' ? run.state : { kind: 'running' },
    previousBindings: [...run.previousBindings ?? [], binding],
    bindings: run.bindings.filter(value => value !== binding), progress: run.progress.map(value => value === task ? { ...value,
      phase: 'pending', decision: undefined, eligibility: { kind: 'immediate' }, inputAnswer: { schemaVersion: 1, source: binding.identity, question: task.decision!.question!, answer } } : value) }, now, timeoutMs);
}
