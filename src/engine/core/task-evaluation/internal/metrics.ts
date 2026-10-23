import { deriveDeckentMetrics, deriveAcceptanceView, sameAttemptIdentity, runSnapshotSchema, readWorkerModelPin, taskEvaluationSchema, type AttemptIdentity, type TaskEvaluation,
  type DeckentMetrics, type DeckentMetricsMeasurements, type CurrentDeckentMetrics, type RunSnapshot, type METRIC_EVIDENCE_KINDS } from '#domain/index.js';
import { evaluatorEvidence } from '#capabilities/index.js';
import { RunStoreError, runLifecycleWriteSchema } from '#engine/core/runs/index.js';
import { taskEvaluationCommitSchema } from './commit.js';
type MetricEvidenceKind = typeof METRIC_EVIDENCE_KINDS[number];

/** Metadata comes from the producer's canonical evaluation or lifecycle command and resulting Run, never the metrics table.
 * `prior` is the current task row of the decided Attempt (adapter-read, digest-checked): a human decision carries its measurements. */
export function deriveAcceptanceMetrics(command: string, input: RunSnapshot, prior?: DeckentMetrics | null): readonly CurrentDeckentMetrics[] {
  const run = runSnapshotSchema.parse(input);
  const payload = JSON.parse(command) as Record<string, unknown>;
  let evaluation: TaskEvaluation | undefined; let identity: AttemptIdentity; let outcome: CurrentDeckentMetrics['outcome'];
  const references = new Map<string, string>(); const kinds: MetricEvidenceKind[] = []; let measured: DeckentMetricsMeasurements = {};
  let carried: Pick<CurrentDeckentMetrics, 'actualModel' | 'acceptanceScore'> = { actualModel: null, acceptanceScore: null };
  if (payload['action'] === 'apply-task-evaluation') {
    const value = { ...payload }; delete value['action'];
    const commit = taskEvaluationCommitSchema.parse(value); evaluation = taskEvaluationSchema.parse(commit.evaluation);
    // An R3 stall retry is not an outcome: the task runs again (an exhausted stall is recorded as failed). A quota park is its own row.
    if (!evaluation.quota && evaluation.stall && run.progress.find(row => row.taskId === evaluation!.identity.taskId)?.phase === 'pending') return [];
    identity = evaluation.identity;
    if (commit.dispatch.output) references.set('dispatch-output', commit.dispatch.output.digest);
    if (commit.dispatch.patch) references.set('workspace-patch', commit.dispatch.patch.digest);
    for (const row of evaluation.criteria.flatMap(value => value.evidenceReferences ?? [])) {
      if (references.has(row.id) && references.get(row.id) !== row.digest) throw new RunStoreError('RUN_STORE_CORRUPT');
      references.set(row.id, row.digest);
    }
    if (evaluation.quota) outcome = { kind: 'quota-park', channelId: evaluation.quota.channelId };
    else {
      const progress = run.progress.find(row => row.taskId === identity.taskId);
      if (!progress || !['accepted', 'failed', 'awaiting-decision'].includes(progress.phase)) throw new RunStoreError('RUN_STORE_CORRUPT');
      outcome = { kind: 'task', status: progress.phase as 'accepted' | 'failed' | 'awaiting-decision', decision: 'system' };
    }
    // A quota park ran no evaluator: its row names no verdict evidence.
    if (!evaluation.quota) for (const row of evaluation.criteria) kinds.push(evaluatorEvidence(run.execution.criteria.find(value => value.criterionId === row.criterionId)?.evaluator ?? { id: '' }).kind);
    const container = commit.dispatch.terminal?.container;
    measured = { startedAtMs: container?.startedAt ? Date.parse(container.startedAt) : null, endedAtMs: container?.finishedAt ? Date.parse(container.finishedAt) : null };
    const model = evaluation.model;
    carried = { acceptanceScore: evaluation.acceptance?.score ?? null, actualModel: model ? { reported: model.init ?? (model.usage?.length === 1 ? model.usage[0]! : null),
      verdict: model.verdict, evidence: model.evidence, capability: model.evidenceCapability } : null };
  } else if (payload['operation'] === 'run-lifecycle') {
    const value = { ...payload }; delete value['operation']; const write = runLifecycleWriteSchema.parse(value);
    const binding = run.bindings.find(row => row.identity.taskId === write.taskId), phase = run.progress.find(row => row.taskId === write.taskId)?.phase;
    if (write.action === 'accept' || write.action === 'reject') {
      // A human decision on an awaiting Task is a task row of its Attempt; a stale prior row of another Attempt carries nothing.
      // A decision without a bound Attempt has no Attempt row to write; the metric never blocks the human step.
      if (!binding || phase !== (write.action === 'accept' ? 'accepted' : 'failed')) return [];
      identity = binding.identity; outcome = { kind: 'task', status: phase, decision: 'human' }; kinds.push('human-decision');
      const same = prior && prior.identity.attemptId === identity.attemptId && prior.identity.taskId === identity.taskId ? prior : null;
      if (same?.schemaVersion === 2) {
        kinds.push(...same.evidenceKinds); carried = { actualModel: same.actualModel, acceptanceScore: same.acceptanceScore };
        measured = { carriedDurationMs: same.durationMs };
      }
      for (const row of same?.evidenceReferences ?? []) references.set(row.id, row.digest);
    } else if (run.state.kind === 'terminal' && run.state.outcome === 'incomplete') {
      const anchor = [...run.bindings].sort((a, b) => a.identity.taskId < b.identity.taskId ? -1 : a.identity.taskId > b.identity.taskId ? 1 : 0)[0]?.identity;
      if (!anchor) throw new RunStoreError('RUN_STORE_CORRUPT');
      identity = anchor; outcome = { kind: 'run', status: 'incomplete' };
    } else return [];
  } else return [];
  if (identity.scopeId !== run.identity.scopeId || identity.runId !== run.identity.runId) throw new RunStoreError('RUN_STORE_CORRUPT');
  const reference = run.execution.tasks.find(row => row.taskId === identity.taskId)?.acceptance;
  const pinned = readWorkerModelPin(run.execution.tasks.find(row => row.taskId === identity.taskId)?.profile.parameters), pin = pinned?.pin;
  return [deriveDeckentMetrics({ identity: { scopeId: identity.scopeId, runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId },
    workClass: evaluation?.acceptance?.workClass ?? reference?.workClass ?? null,
    policyRevision: evaluation?.acceptance?.policyRevision ?? reference?.policyRevision ?? null,
    profileVersion: evaluation?.acceptance?.profileVersion ?? reference?.profileVersion ?? null,
    // S7 (agent/skill catalog) supplies the digest; until then the row says plainly that no skill set was recorded.
    skillSetDigest: null, model: pin ? { channelId: pin.channelId, modelId: pin.modelId } : null, outcome, attemptSequence: identity.generation,
    effort: pinned?.reasoningEffort ?? null, ...carried, evidenceKinds: kinds,
    evidenceReferences: [...references].map(([id, digest]) => ({ id, digest })) }, measured)];
}

/** Select canonical receipt evaluations at or before the inspected Run revision; never sample a later transition. */
export function selectRunAcceptanceEvaluations(snapshot: RunSnapshot, receipts: readonly Readonly<{ commandId: string; command: string }>[]): readonly TaskEvaluation[] {
  const run = runSnapshotSchema.parse(snapshot);
  const selected = new Map<string, { revision: number; evaluation: TaskEvaluation }>();
  const seen = new Set<string>();
  try {
    for (const receipt of receipts) {
      const { action, ...input } = JSON.parse(receipt.command);
      if (action !== 'apply-task-evaluation') throw new RunStoreError('RUN_STORE_CORRUPT');
      const commit = taskEvaluationCommitSchema.parse(input), evaluation = commit.evaluation;
      if (receipt.commandId !== commit.commandId || !sameAttemptIdentity(commit.dispatch.request.identity, evaluation.identity)) throw new RunStoreError('RUN_STORE_CORRUPT');
      if (commit.expectedRevision >= run.revision) continue;
      const binding = run.bindings.find(row => sameAttemptIdentity(row.identity, evaluation.identity));
      if (!binding || evaluation.graphRevision !== run.graph.revision || evaluation.attemptRevision !== binding.observedRevision) continue;
      deriveAcceptanceView(run, binding.identity.taskId, evaluation);
      const key = `${binding.identity.taskId}/${commit.expectedRevision}`;
      if (seen.has(key)) throw new RunStoreError('RUN_STORE_CORRUPT');
      seen.add(key);
      const prior = selected.get(binding.identity.taskId);
      if (!prior || prior.revision < commit.expectedRevision) selected.set(binding.identity.taskId, { revision: commit.expectedRevision, evaluation });
    }
  } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  return Object.freeze(run.graph.tasks.flatMap(task => { const row = selected.get(task.id); return row ? [row.evaluation] : []; }));
}
