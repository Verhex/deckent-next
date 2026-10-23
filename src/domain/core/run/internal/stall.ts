import { counterSchema } from '#domain/core/primitives/index.js';
import { sameAttemptIdentity, type AttemptIdentity } from '#domain/core/attempt/index.js';
import { checkedRun, RunError, type STALL_CAUSES } from './contract.js';
import { reconcileRunLifecycle } from './lifecycle.js';
import { taskAttemptCeilingReached } from './lost.js';
export type StallCause = typeof STALL_CAUSES[number];
/**
 * R3 (owner D4a/D5a): the one owner of the bounded stall retry, modelled on the quota park/reset pair. A worker stopped for host-observed
 * silence (`inactivity`) or a clean exit without a valid report goes back to `pending` for a NEW Attempt (next generation, new lease) after
 * `backoffMs`, at most the Run's frozen `maxRetries` times per task; past the bound the task fails with its typed reason and the Run never
 * parks for it. Callers prove a settled, workspace-only Attempt first: a stall never accepts work and never re-runs uncertain effects.
 */
export function recoverStalledTask(input: unknown, expectedRevision: number, identity: AttemptIdentity, cause: StallCause,
  timing: Readonly<{ now: number; backoffMs: number; timeoutMs: number }>) {
  const run = checkedRun(input, expectedRevision); counterSchema.parse(timing.backoffMs);
  const task = run.progress.find(row => row.taskId === identity.taskId), binding = run.bindings.find(row => sameAttemptIdentity(row.identity, identity));
  const policy = run.execution.tasks.find(row => row.taskId === identity.taskId)?.stall;
  if (!task || !binding || !policy || task.phase !== 'evaluating' || task.unresolvedEffects || run.cancelRequested || run.state.kind === 'terminal'
    || binding.observedKind !== 'exited') throw new RunError('RUN_ATTEMPT_CONFLICT');
  const retry = (run.previousBindings ?? []).filter(row => row.identity.taskId === identity.taskId && row.observedKind === 'stalled').length < policy.maxRetries
    && !taskAttemptCeilingReached(run, identity.taskId); // S6R-5: the total Attempt ceiling stall shares with lost continuation
  const eligibility = timing.backoffMs > 0 ? { kind: 'not-before' as const, at: counterSchema.parse(timing.now + timing.backoffMs) } : { kind: 'immediate' as const };
  const next = retry ? { ...task, phase: 'pending' as const, decision: undefined, notAcceptedReason: undefined, eligibility }
    : { ...task, phase: 'failed' as const, decision: undefined, notAcceptedReason: cause === 'inactivity' ? 'worker-stalled' as const : cause };
  const snapshot = reconcileRunLifecycle({ ...run, revision: run.revision + 1, progress: run.progress.map(row => row === task ? next : row),
    ...(retry ? { bindings: run.bindings.filter(row => row !== binding),
      previousBindings: [...run.previousBindings ?? [], { ...binding, observedKind: 'stalled', stallCause: cause }] } : {}) }, timing.now, timing.timeoutMs);
  return Object.freeze({ snapshot, outcome: retry ? 'retry' as const : 'exhausted' as const });
}
