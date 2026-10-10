import { runSnapshotSchema, RunError, reconcileRunLifecycle, type RunLifecycleTiming } from '#domain/core/run/index.js';
import { inspectTaskEvaluation, TaskEvaluationError } from './evaluation.js';
/** Pure proposed transition, not an acceptance grant. Trusted application/store must independently
 * authorize, verify producer/criterion/artifact provenance and commit this snapshot with its immutable
 * evaluation receipt and fresh Attempt revision in one transaction. Replay belongs to that store.
 */
export function applyTaskEvaluation(runInput: unknown, expectedRevision: number, evaluationInput: unknown, timing: RunLifecycleTiming & { unknownDisposition?: 'fail' }) {
  const parsed = runSnapshotSchema.safeParse(runInput);
  if (!parsed.success) throw new RunError('RUN_INVALID');
  const run = parsed.data;
  if (run.revision !== expectedRevision || !Number.isSafeInteger(run.revision + 1)) throw new RunError('RUN_REVISION_CONFLICT');
  const result = inspectTaskEvaluation(run, evaluationInput);
  const prior = run.progress.find(task => task.taskId === result.evaluation.identity.taskId)!.decision;
  if (prior && (prior.deadline <= timing.now || (run.state.kind === 'parked' && run.state.deadline <= timing.now))) throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY');
  const disposition = result.conclusion === 'unknown' && !result.evaluation.workerExit && timing.unknownDisposition === 'fail' ? 'fail' : result.conclusion;
  const phase = { pass: 'accepted', fail: 'failed', unknown: 'awaiting-decision' } as const;
  // Even HOLD consumes a revision: concurrent evaluations cannot reuse the same state fence.
  const snapshot = reconcileRunLifecycle({ ...run, revision: run.revision + 1,
    progress: run.progress.map(task => task.taskId === result.evaluation.identity.taskId ? { ...task, decision: undefined, notAcceptedReason: undefined, phase: phase[disposition],
      ...(result.evaluation.workspaceChange?.changedFiles === 0 && run.graph.tasks.find(value => value.id === task.taskId)?.workInput?.noChangeAllowed !== true ? { notAcceptedReason: 'no-change-produced' as const } : {}), ...(disposition === 'unknown' ? { decision: { reason: result.evaluation.workerExit ? 'needs-input' : 'evaluation-unknown', ...(result.evaluation.workerExit ? { question: result.evaluation.workerExit.question } : {}), since: prior?.since ?? timing.now, deadline: prior?.deadline ?? timing.now + timing.timeoutMs, evaluationId: result.evaluation.evaluationId,
      ...(result.evaluation.evidenceDigests ? { evidenceDigests: result.evaluation.evidenceDigests } : {}) } } : {}) } : task),
  }, timing.now, timing.timeoutMs);
  return Object.freeze({ ...result, snapshot });
}
