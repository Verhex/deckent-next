import { z } from 'zod';
import { modelUsageEvidenceSchema, readLegacyModelUsageEvidence } from '#domain/core/provider-catalog/index.js';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
import { attemptIdentitySchema, sameAttemptIdentity } from '#domain/core/attempt/index.js';
import { runSnapshotSchema } from '#domain/core/run/index.js';
import { workerModelPinSchema, workerProviderSchema } from '#domain/core/worker-event/index.js';
const criterion = z.object({ criterionId: identitySchema, verdict: z.enum(['pass', 'fail', 'unknown']),
  evidenceIds: z.array(identitySchema).readonly(),
}).strict().superRefine((value, context) => {
  if ((value.verdict !== 'unknown' && value.evidenceIds.length === 0) || new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'TASK_EVALUATION_INVALID' });
  }
}).readonly();
const modelText = z.string().min(1).max(256);
/**
 * Worker model evidence of a pinned native attempt (WORKER-CURRENCY-2, owner rule A 2026-09-30; Jev 933e43f2, 58ffe1c9). Recorded with the
 * evaluation; present exactly when the Run's frozen profile pins a model. The verdict is the host-sealed comparison of worker-reported usage
 * with the pin (not provider attestation); `absent` evidence means no sealed log. Tasks without a pin carry no field (bytes unchanged).
 */
const legacyTaskEvaluationModelSchema = z.object({ provider: workerProviderSchema, requested: workerModelPinSchema,
  init: modelText.nullable(), usage: z.array(modelText).max(16).readonly().nullable(), verdict: z.enum(['verified', 'substituted', 'unverified']),
  unexpected: z.array(modelText).max(17).readonly(), evidence: z.enum(['sealed', 'absent']) }).strict();
/** Additive evidence contract. Missing capability is migrated only while reading pre-stamping records. */
export const taskEvaluationModelSchema = legacyTaskEvaluationModelSchema.extend({ evidenceCapability: modelUsageEvidenceSchema.optional() }).transform(model =>
  Object.freeze({ ...model, evidenceCapability: model.evidenceCapability ?? readLegacyModelUsageEvidence(model.provider) }));
export type TaskEvaluationModel = z.infer<typeof taskEvaluationModelSchema>;
export const taskEvaluationSchema = z.object({ schemaVersion: z.literal(1), evaluationId: identitySchema,
  identity: attemptIdentitySchema, graphRevision: counterSchema.positive(), attemptRevision: counterSchema.positive(),
  sharedNotes: z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), count: counterSchema.positive() }).strict().optional(),
  handoff: z.discriminatedUnion('status', [z.object({ status: z.literal('valid'), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), z.object({ status: z.literal('invalid'), code: z.enum(['HANDOFF_ARTIFACT_MISMATCH', 'HANDOFF_INVALID']) }).strict()]).optional(),
  criteria: z.array(criterion).min(1).readonly(), model: taskEvaluationModelSchema.optional(),
  evidenceDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2).readonly().optional(),
  returnEvidence: z.object({ kind: z.enum(['output', 'model-seal']), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly().optional(),
}).strict().readonly();
/** Acceptance consequence: an undeclared model fails the attempt; an attempt with session-event model usage without a sealed
 * 'verified' verdict is held; attempts without per-model evidence stay accepted by their criteria, visibly unverified. */
export function taskModelConclusion(model: TaskEvaluationModel | undefined): 'fail' | 'unknown' | null {
  if (!model) return null;
  if (model.verdict === 'substituted') return 'fail';
  return model.evidenceCapability === 'session-events' && model.verdict !== 'verified' ? 'unknown' : null;
}
export type TaskEvaluation = z.infer<typeof taskEvaluationSchema>;
export class TaskEvaluationError extends Error {
  constructor(readonly code: 'TASK_EVALUATION_INVALID' | 'TASK_EVALUATION_STALE' | 'TASK_EVALUATION_NOT_READY' | 'TASK_EVALUATION_CRITERIA') {
    super(code); this.name = 'TaskEvaluationError';
  }
}
/** Pure evidence binding only: it neither authenticates a Brain nor verifies artifacts nor accepts a Task.
 * Application/store must establish provenance and fresh attempt/Run evidence before an atomic transition.
 */
export function inspectTaskEvaluation(runInput: unknown, input: unknown) {
  const run = runSnapshotSchema.safeParse(runInput); const parsed = taskEvaluationSchema.safeParse(input);
  if (!run.success || !parsed.success) throw new TaskEvaluationError('TASK_EVALUATION_INVALID');
  const evaluation = parsed.data; const binding = run.data.bindings.find(value => value.identity.taskId === evaluation.identity.taskId);
  if (!binding || !sameAttemptIdentity(binding.identity, evaluation.identity) || evaluation.graphRevision !== run.data.graph.revision
    || evaluation.attemptRevision !== binding.observedRevision) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  const task = run.data.graph.tasks.find(value => value.id === evaluation.identity.taskId)!;
  const progress = run.data.progress.find(value => value.taskId === task.id)!;
  const returned = progress.phase === 'awaiting-decision' && evaluation.returnEvidence;
  if (returned && (!progress.decision!.evidenceDigests || !evaluation.evidenceDigests?.includes(returned.digest) || progress.decision!.evidenceDigests.includes(returned.digest)
    || (returned.kind === 'model-seal' && (evaluation.model?.verdict !== 'verified' || evaluation.model.evidence !== 'sealed')))) throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY');
  if (run.data.cancelRequested || (progress.phase !== 'evaluating' && !returned) || progress.unresolvedEffects || binding.observedKind !== 'exited'
    || run.data.state.kind === 'terminal') throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY');
  if (evaluation.returnEvidence && progress.phase !== 'awaiting-decision') throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY');
  const byId = new Map(evaluation.criteria.map(value => [value.criterionId, value]));
  if (byId.size !== evaluation.criteria.length || byId.size !== task.acceptanceCriteria.length
    || task.acceptanceCriteria.some(id => !byId.has(id))) throw new TaskEvaluationError('TASK_EVALUATION_CRITERIA');
  const criteria = task.acceptanceCriteria.map(id => { const value = byId.get(id)!; return { ...value, evidenceIds: [...value.evidenceIds].sort() }; });
  const normalized = taskEvaluationSchema.parse({ ...evaluation, criteria });
  const gate = taskModelConclusion(normalized.model);
  const conclusion: 'pass' | 'fail' | 'unknown' = gate === 'fail' || criteria.some(value => value.verdict === 'fail') ? 'fail'
    : gate === 'unknown' || criteria.some(value => value.verdict === 'unknown') ? 'unknown' : 'pass';
  return Object.freeze({ evaluation: normalized, conclusion });
}
