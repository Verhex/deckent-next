import { TaskEvaluationError, sameAttemptIdentity, type AttemptIdentity, type RunSnapshot, type TaskEvaluationModel } from '#domain/index.js';
import type { RunBoundDispatchStore } from '#engine/core/dispatch/index.js';
import type { WorkerEventLogStore } from '#engine/core/worker-observation/index.js';
/** Capture exact immutable custody; each output/seal digest can open one return, never a retry loop. */
export async function evaluationRecovery(store: Pick<WorkerEventLogStore, 'loadWorkerEventLog'>, run: RunSnapshot,
  identity: AttemptIdentity, dispatch: Awaited<ReturnType<RunBoundDispatchStore['loadBoundDispatch']>>, model: TaskEvaluationModel | undefined) {
  const log = await store.loadWorkerEventLog(identity.scopeId, identity.attemptId);
  if (log && !sameAttemptIdentity(log.identity, identity)) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  const evidenceDigests = [dispatch?.output?.digest, log?.events.digest].filter((value): value is string => value !== undefined);
  const decision = run.progress.find(task => task.taskId === identity.taskId)?.decision;
  if (!decision) return { evidenceDigests };
  const seen = decision.evidenceDigests ?? [];
  const returnEvidence = dispatch?.output && !seen.includes(dispatch.output.digest) ? { kind: 'output' as const, digest: dispatch.output.digest }
    : model?.verdict === 'verified' && model.evidence === 'sealed' && log && !seen.includes(log.events.digest)
      ? { kind: 'model-seal' as const, digest: log.events.digest } : undefined;
  if (!returnEvidence) throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY');
  return { evidenceDigests, returnEvidence };
}
