import { sameAttemptIdentity, attemptSnapshotSchema, type AttemptSnapshot } from '#domain/core/attempt/index.js';
import { reconcileRunLifecycle, type RunLifecycleTiming } from './lifecycle.js';
import { checkedRun, RunError, type RunSnapshot } from './contract.js';

/** What the dispatch journal holds for a cancelled attempt: no claim, a pending claim, its launch decision (`denied` or `granted`), or a granted
 * launch whose terminal exit is recorded. */
export type CancelledAttemptDispatch = 'none' | 'pending' | 'denied' | 'granted' | 'exited';
/** Narrow on purpose: a reconciling task stays with its reconciler. */
const SETTLEABLE_PHASES: ReadonlySet<string> = new Set(['active', 'evaluating']);
/** S2-D3: the one rule for a cancelled attempt. Only an attempt whose launch was never granted (no claim, or the launch decision denying it) is
 * prevented; only an exited one whose exit is projected onto its binding is settled; a pending claim is left to its launch decision. */
export function classifyCancelledAttempt(run: RunSnapshot, attempt: AttemptSnapshot, dispatch: CancelledAttemptDispatch): 'already-cancelled' | 'prevent' | 'settle' | 'not-settleable' {
  const binding = run.bindings.find(value => sameAttemptIdentity(value.identity, attempt.identity));
  const task = run.progress.find(value => value.taskId === attempt.identity.taskId);
  if (!binding || !task) throw new RunError('RUN_ATTEMPT_CONFLICT');
  if (task.phase === 'cancelled') return 'already-cancelled';
  if (task.unresolvedEffects || !SETTLEABLE_PHASES.has(task.phase)) return 'not-settleable';
  if ((dispatch === 'none' || dispatch === 'denied') && attempt.cancelRequested && attempt.lastObservation === null && binding.observedRevision === null && task.phase === 'active') return 'prevent';
  return dispatch === 'exited' && (run.cancelRequested || attempt.cancelRequested) && task.phase === 'evaluating' && binding.observedKind === 'exited'
    && binding.observedRevision === attempt.revision && attempt.lastObservation?.result.kind === 'exited' ? 'settle' : 'not-settleable';
}
/** The transition both verdicts apply: the attempt's task becomes `cancelled`; repeated settlement is idempotent. */
export function cancelRunAttempt(input: unknown, expectedRevision: number, attemptInput: unknown, dispatch: CancelledAttemptDispatch, verdict: 'prevent' | 'settle', timing: RunLifecycleTiming) {
  const run = checkedRun(input, expectedRevision), attempt = attemptSnapshotSchema.parse(attemptInput), found = classifyCancelledAttempt(run, attempt, dispatch);
  if (found === 'already-cancelled') return run;
  if (found !== verdict) throw new RunError('RUN_ATTEMPT_CONFLICT');
  return reconcileRunLifecycle({ ...run, revision: run.revision + 1,
    progress: run.progress.map(value => value.taskId === attempt.identity.taskId ? { ...value, phase: 'cancelled' } : value) }, timing.now, timing.timeoutMs);
}
/** Settles an exited attempt as `cancelled` once cancellation intent is durable on the Run or the attempt. */
export const settleCancelledRunAttempt = (input: unknown, expectedRevision: number, attemptInput: unknown, dispatch: CancelledAttemptDispatch, timing: RunLifecycleTiming) =>
  cancelRunAttempt(input, expectedRevision, attemptInput, dispatch, 'settle', timing);
