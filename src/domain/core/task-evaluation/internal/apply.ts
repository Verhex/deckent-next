import { runSnapshotSchema, RunError, reconcileRunLifecycle, DEFAULT_RUN_PARK_TIMEOUT_MS, type RunLifecycleTiming } from '#domain/core/run/index.js';
import { inspectTaskEvaluation } from './evaluation.js';
/** Pure proposed transition, not an acceptance grant. Trusted application/store must independently
 * authorize, verify producer/criterion/artifact provenance and commit this snapshot with its immutable
 * evaluation receipt and fresh Attempt revision in one transaction. Replay belongs to that store.
 */
export function applyTaskEvaluation(runInput: unknown, expectedRevision: number, evaluationInput: unknown, timing: RunLifecycleTiming & { unknownDisposition?: 'fail' } = { now: 0, timeoutMs: DEFAULT_RUN_PARK_TIMEOUT_MS }) {
  const parsed = runSnapshotSchema.safeParse(runInput);
  if (!parsed.success) throw new RunError('RUN_INVALID');
  const run = parsed.data;
  if (run.revision !== expectedRevision || !Number.isSafeInteger(run.revision + 1)) throw new RunError('RUN_REVISION_CONFLICT');
  const result = inspectTaskEvaluation(run, evaluationInput);
  const disposition = result.conclusion === 'unknown' && timing.unknownDisposition === 'fail' ? 'fail' : result.conclusion;
  const phase = { pass: 'accepted', fail: 'failed', unknown: 'awaiting-decision' } as const;
  // Even HOLD consumes a revision: concurrent evaluations cannot reuse the same state fence.
  const snapshot = reconcileRunLifecycle({ ...run, revision: run.revision + 1,
    progress: run.progress.map(task => task.taskId === result.evaluation.identity.taskId ? { ...task, phase: phase[disposition], ...(disposition === 'unknown' ? { decision: { reason: 'evaluation-unknown', since: timing.now, deadline: timing.now + timing.timeoutMs, evaluationId: result.evaluation.evaluationId } } : {}) } : task),
  }, timing.now, timing.timeoutMs);
  return Object.freeze({ ...result, snapshot });
}
