import { deriveDeckentMetrics, runSnapshotSchema, readWorkerModelPin, taskEvaluationSchema, type AttemptIdentity, type TaskEvaluation, type DeckentMetrics, type RunSnapshot } from '#domain/index.js';
import { RunStoreError, runLifecycleWriteSchema } from '#engine/core/runs/index.js';
import { taskEvaluationCommitSchema } from './commit.js';

/** Metadata comes from the producer's canonical evaluation and resulting Run, never the metrics table. */
export function deriveAcceptanceMetric(command: string, input: RunSnapshot): DeckentMetrics | null {
  const run = runSnapshotSchema.parse(input);
  const payload = JSON.parse(command) as Record<string, unknown>;
  let evaluation: TaskEvaluation | undefined; let identity: AttemptIdentity; let outcome: DeckentMetrics['outcome'];
  const references = new Map<string, string>();
  if (payload['action'] === 'apply-task-evaluation') {
    const value = { ...payload }; delete value['action'];
    const commit = taskEvaluationCommitSchema.parse(value); evaluation = taskEvaluationSchema.parse(commit.evaluation);
    identity = evaluation.identity;
    if (commit.dispatch.output) references.set('dispatch-output', commit.dispatch.output.digest);
    if (commit.dispatch.patch) references.set('workspace-patch', commit.dispatch.patch.digest);
    for (const row of evaluation.criteria.flatMap(value => value.evidenceReferences ?? [])) {
      if (references.has(row.id) && references.get(row.id) !== row.digest) throw new RunStoreError('RUN_STORE_CORRUPT');
      references.set(row.id, row.digest);
    }
    const progress = run.progress.find(row => row.taskId === identity.taskId);
    if (!progress || !['accepted', 'failed', 'awaiting-decision'].includes(progress.phase)) throw new RunStoreError('RUN_STORE_CORRUPT');
    outcome = { kind: 'task', status: progress.phase as 'accepted' | 'failed' | 'awaiting-decision' };
  } else if (payload['operation'] === 'run-lifecycle' && run.state.kind === 'terminal' && run.state.outcome === 'incomplete') {
    const value = { ...payload }; delete value['operation']; runLifecycleWriteSchema.parse(value);
    const anchor = [...run.bindings].sort((a, b) => a.identity.taskId < b.identity.taskId ? -1 : a.identity.taskId > b.identity.taskId ? 1 : 0)[0]?.identity;
    if (!anchor) throw new RunStoreError('RUN_STORE_CORRUPT');
    identity = anchor; outcome = { kind: 'run', status: 'incomplete' };
  } else return null;
  if (identity.scopeId !== run.identity.scopeId || identity.runId !== run.identity.runId) throw new RunStoreError('RUN_STORE_CORRUPT');
  const reference = run.execution.tasks.find(row => row.taskId === identity.taskId)?.acceptance;
  const pin = readWorkerModelPin(run.execution.tasks.find(row => row.taskId === identity.taskId)?.profile.parameters)?.pin;
  return deriveDeckentMetrics({ identity: { scopeId: identity.scopeId, runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId },
    workClass: evaluation?.acceptance?.workClass ?? reference?.workClass ?? null,
    policyRevision: evaluation?.acceptance?.policyRevision ?? reference?.policyRevision ?? null,
    profileVersion: evaluation?.acceptance?.profileVersion ?? reference?.profileVersion ?? null,
    skillSetDigest: null, model: pin ?? null, outcome, attemptSequence: identity.generation,
    evidenceReferences: [...references].map(([id, digest]) => ({ id, digest })) });
}
