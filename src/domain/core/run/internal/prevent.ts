import { sameAttemptIdentity, attemptSnapshotSchema } from '#domain/core/attempt/index.js';
import { checkedRun, runSnapshotSchema, RunError } from './contract.js';

/** Application proof that launch permission was denied before execution. This is not a
 * supervisor observation or a fabricated exit. Existing uncertain effects must remain open. */
export function preventRunAttempt(input: unknown, expectedRevision: number, attemptInput: unknown) {
  const run = checkedRun(input, expectedRevision); const attempt = attemptSnapshotSchema.parse(attemptInput); const identity = attempt.identity;
  const binding = run.bindings.find(value => sameAttemptIdentity(value.identity, identity));
  const task = run.progress.find(value => value.taskId === identity.taskId);
  if (!attempt.cancelRequested || attempt.lastObservation !== null || !binding || binding.observedRevision !== null || !task || task.unresolvedEffects
    || !['active', 'cancelled'].includes(task.phase)) throw new RunError('RUN_ATTEMPT_CONFLICT');
  if (task.phase === 'cancelled') return run;
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1,
    progress: run.progress.map(value => value === task ? { ...value, phase: 'cancelled' } : value) });
}
