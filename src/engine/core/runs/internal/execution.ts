import { attemptIdentitySchema, attemptSnapshotSchema, runSnapshotSchema, sameAttemptIdentity } from '#domain/index.js';
import { RunStoreError } from './store.js';
import { assertRunExecution } from './registry.js';

/** Select an admitted task template before workspace effects. Atomic launch remains the final fence. */
export function selectReservedTaskProfile(runInput: unknown, attemptInput: unknown, identityInput: unknown) {
  const identity = attemptIdentitySchema.parse(identityInput);
  const run = runSnapshotSchema.parse(runInput); const attempt = attemptSnapshotSchema.parse(attemptInput);
  assertRunExecution(run.graph, run.execution);
  if (!sameAttemptIdentity(attempt.identity, identity) || !run.bindings.some(binding => sameAttemptIdentity(binding.identity, identity))
    || run.cancelRequested || attempt.cancelRequested || attempt.lastObservation !== null
    || run.progress.find(task => task.taskId === identity.taskId)?.phase !== 'active') {
    throw new RunStoreError('RUN_STORE_CONFLICT');
  }
  const selected = run.execution.tasks.find(task => task.taskId === identity.taskId);
  if (!selected) throw new RunStoreError('RUN_STORE_CORRUPT');
  return selected.profile;
}
