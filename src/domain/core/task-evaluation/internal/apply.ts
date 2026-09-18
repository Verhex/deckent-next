import { runSnapshotSchema, RunError } from '#domain/core/run/index.js';
import { inspectTaskEvaluation } from './evaluation.js';
/** Pure proposed transition, not an acceptance grant. Trusted application/store must independently
 * authorize, verify producer/criterion/artifact provenance and commit this snapshot with its immutable
 * evaluation receipt and fresh Attempt revision in one transaction. Replay belongs to that store.
 */
export function applyTaskEvaluation(runInput: unknown, expectedRevision: number, evaluationInput: unknown) {
  const parsed = runSnapshotSchema.safeParse(runInput);
  if (!parsed.success) throw new RunError('RUN_INVALID');
  const run = parsed.data;
  if (run.revision !== expectedRevision || !Number.isSafeInteger(run.revision + 1)) throw new RunError('RUN_REVISION_CONFLICT');
  const result = inspectTaskEvaluation(run, evaluationInput);
  const phase = { pass: 'accepted', fail: 'failed', unknown: 'evaluating' } as const;
  // Even HOLD consumes a revision: concurrent evaluations cannot reuse the same state fence.
  const snapshot = runSnapshotSchema.parse({ ...run, revision: run.revision + 1,
    progress: run.progress.map(task => task.taskId === result.evaluation.identity.taskId ? { ...task, phase: phase[result.conclusion] } : task),
  });
  return Object.freeze({ ...result, snapshot });
}
