import { sameAttemptIdentity, attemptSnapshotSchema } from '#domain/core/attempt/index.js';
import { checkedRun, runSnapshotSchema, RunError } from './contract.js';

/** Settles an exited attempt as `cancelled` once cancellation intent is durable on the Run or the attempt.
 * The terminal exit must already be projected onto the Run binding; started/unknown observations, unresolved
 * effects and accepted/failed tasks are never settled here. Repeated settlement is idempotent. */
export function settleCancelledRunAttempt(input: unknown, expectedRevision: number, attemptInput: unknown) {
  const run = checkedRun(input, expectedRevision); const attempt = attemptSnapshotSchema.parse(attemptInput); const identity = attempt.identity;
  const binding = run.bindings.find(value => sameAttemptIdentity(value.identity, identity));
  const task = run.progress.find(value => value.taskId === identity.taskId);
  if (!binding || !task) throw new RunError('RUN_ATTEMPT_CONFLICT');
  if (task.phase === 'cancelled') return run;
  if (!run.cancelRequested && !attempt.cancelRequested) throw new RunError('RUN_ATTEMPT_CONFLICT');
  if (binding.observedKind !== 'exited' || binding.observedRevision !== attempt.revision || attempt.lastObservation?.result.kind !== 'exited') {
    throw new RunError('RUN_ATTEMPT_CONFLICT');
  }
  if (task.phase !== 'evaluating' || task.unresolvedEffects) throw new RunError('RUN_ATTEMPT_CONFLICT');
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1,
    progress: run.progress.map(value => value === task ? { ...value, phase: 'cancelled' } : value) });
}
