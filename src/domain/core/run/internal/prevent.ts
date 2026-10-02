import { sameAttemptIdentity, attemptSnapshotSchema } from '#domain/core/attempt/index.js';
import { reconcileRunLifecycle, DEFAULT_RUN_PARK_TIMEOUT_MS, type RunLifecycleTiming } from './lifecycle.js';
import { checkedRun, RunError } from './contract.js';

/** Application proof that launch permission was denied before execution. This is not a
 * supervisor observation or a fabricated exit. Existing uncertain effects must remain open. */
export function preventRunAttempt(input: unknown, expectedRevision: number, attemptInput: unknown, timing: RunLifecycleTiming = { now: 0, timeoutMs: DEFAULT_RUN_PARK_TIMEOUT_MS }) {
  const run = checkedRun(input, expectedRevision); const attempt = attemptSnapshotSchema.parse(attemptInput); const identity = attempt.identity;
  const binding = run.bindings.find(value => sameAttemptIdentity(value.identity, identity));
  const task = run.progress.find(value => value.taskId === identity.taskId);
  if (!attempt.cancelRequested || attempt.lastObservation !== null || !binding || binding.observedRevision !== null || !task || task.unresolvedEffects
    || !['active', 'cancelled'].includes(task.phase)) throw new RunError('RUN_ATTEMPT_CONFLICT');
  if (task.phase === 'cancelled') return run;
  return reconcileRunLifecycle({ ...run, revision: run.revision + 1,
    progress: run.progress.map(value => value === task ? { ...value, phase: 'cancelled' } : value) }, timing.now, timing.timeoutMs);
}
