import { z } from 'zod';
import { counterSchema } from '#domain/core/primitives/index.js';
import { attemptIdentitySchema, attemptSnapshotSchema, sameAttemptIdentity } from '#domain/core/attempt/index.js';
import { validateTaskGraph, inspectTaskReadiness, type TaskProgress } from '#domain/core/task-graph/index.js';
import { checkedRun, runIdentitySchema, runSnapshotSchema, RunError } from './contract.js';
export function createRun(identityInput: unknown, graphInput: unknown, nowInput: unknown, execution: unknown, branch?: unknown) {
  const identity = runIdentitySchema.parse(identityInput); const graph = validateTaskGraph(graphInput); counterSchema.parse(nowInput);
  return runSnapshotSchema.parse({ schemaVersion: 3, identity, revision: 0, graph, execution, ...(branch === undefined ? {} : { branch }), cancelRequested: false, bindings: [],
    progress: graph.tasks.map(task => ({ taskId: task.id, phase: 'pending', unresolvedEffects: false, eligibility: { kind: 'immediate' } })) });
}
/** Admission transition only. Application/store must atomically reserve capacity and create these
 * attempts with the Run revision. A domain result alone never grants supervisor dispatch.
 */
export function reserveRunTasks(input: unknown, expectedRevision: number, identitiesInput: unknown, nowInput: unknown) {
  const run = checkedRun(input, expectedRevision); if (run.cancelRequested) throw new RunError('RUN_CANCEL_REQUESTED');
  const identities = z.array(attemptIdentitySchema).min(1).parse(identitiesInput); const now = counterSchema.parse(nowInput);
  const ready = new Set(inspectTaskReadiness(run.graph, { graphRevision: run.graph.revision, progress: run.progress, now }).filter(task => task.disposition === 'ready').map(task => task.taskId));
  const selected = new Set<string>(); const attempts = new Set(run.bindings.map(binding => binding.identity.attemptId));
  for (const id of identities) {
    if (id.runId !== run.identity.runId || id.scopeId !== run.identity.scopeId || id.layoutRevision !== run.identity.layoutRevision || attempts.has(id.attemptId) || selected.has(id.taskId) || run.bindings.some(binding => binding.identity.taskId === id.taskId)) throw new RunError('RUN_ATTEMPT_CONFLICT');
    if (!ready.has(id.taskId)) throw new RunError('RUN_TASK_NOT_READY');
    selected.add(id.taskId); attempts.add(id.attemptId);
  }
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1,
    progress: run.progress.map(task => selected.has(task.taskId) ? { ...task, phase: 'active' } : task),
    bindings: [...run.bindings, ...identities.map(identity => ({ identity, observedRevision: null, observedKind: null }))] });
}
/** Only consumes authoritative attempt evidence; process exit is evaluation input, never acceptance.
 * Unknown effects remain held until a separate reconciler establishes their disposition.
 */
export function observeRunAttempt(input: unknown, expectedRevision: number, attemptInput: unknown) {
  const run = checkedRun(input, expectedRevision); const attempt = attemptSnapshotSchema.parse(attemptInput);
  const binding = run.bindings.find(value => value.identity.taskId === attempt.identity.taskId);
  if (!binding || !sameAttemptIdentity(binding.identity, attempt.identity)) throw new RunError('RUN_ATTEMPT_CONFLICT');
  const observation = attempt.lastObservation;
  if (!observation || (binding.observedRevision !== null && attempt.revision <= binding.observedRevision)) throw new RunError('RUN_OBSERVATION_STALE');
  if ((binding.observedKind === 'exited' || binding.observedKind === 'cancelled') && observation.result.kind !== binding.observedKind) throw new RunError('RUN_ATTEMPT_CONFLICT');
  const progress = run.progress.map(task => {
    if (task.taskId !== attempt.identity.taskId) return task;
    if (!['active', 'evaluating', 'reconciling'].includes(task.phase)) throw new RunError('RUN_ATTEMPT_CONFLICT');
    const uncertain = task.unresolvedEffects || observation.result.kind === 'unknown' || observation.result.kind === 'cancelled';
    const phase: TaskProgress['phase'] = uncertain ? 'reconciling' : observation.result.kind === 'exited' ? 'evaluating' : 'active';
    return { ...task, phase, unresolvedEffects: uncertain };
  });
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1, progress,
    bindings: run.bindings.map(value => value === binding ? { ...value, observedRevision: attempt.revision, observedKind: observation.result.kind } : value) });
}
/** Cancellation intent. Tasks that were never reserved have no attempt or effect, so they close as cancelled in the same
 * transition; bound attempts are settled separately from their evidence. Re-requesting closes pending tasks left by older revisions.
 */
export function requestRunCancellation(input: unknown, expectedRevision: number) {
  const run = checkedRun(input, expectedRevision);
  const bound = new Set(run.bindings.map(binding => binding.identity.taskId));
  const unreserved = run.progress.some(task => task.phase === 'pending' && !bound.has(task.taskId));
  if (run.cancelRequested && !unreserved) return run;
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1, cancelRequested: true,
    progress: run.progress.map(task => task.phase === 'pending' && !bound.has(task.taskId) ? { ...task, phase: 'cancelled' } : task) });
}
