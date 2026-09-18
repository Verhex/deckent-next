import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
import { attemptIdentitySchema, sameAttemptIdentity } from '#domain/core/attempt/index.js';
import { runSnapshotSchema } from '#domain/core/run/index.js';
const criterion = z.object({ criterionId: identitySchema, verdict: z.enum(['pass', 'fail', 'unknown']),
  evidenceIds: z.array(identitySchema).readonly(),
}).strict().superRefine((value, context) => {
  if ((value.verdict !== 'unknown' && value.evidenceIds.length === 0) || new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'TASK_EVALUATION_INVALID' });
  }
}).readonly();
export const taskEvaluationSchema = z.object({ schemaVersion: z.literal(1), evaluationId: identitySchema,
  identity: attemptIdentitySchema, graphRevision: counterSchema.positive(), attemptRevision: counterSchema.positive(),
  criteria: z.array(criterion).min(1).readonly(),
}).strict().readonly();
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
  if (run.data.cancelRequested || progress.phase !== 'evaluating' || progress.unresolvedEffects || binding.observedKind !== 'exited') throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY');
  const byId = new Map(evaluation.criteria.map(value => [value.criterionId, value]));
  if (byId.size !== evaluation.criteria.length || byId.size !== task.acceptanceCriteria.length
    || task.acceptanceCriteria.some(id => !byId.has(id))) throw new TaskEvaluationError('TASK_EVALUATION_CRITERIA');
  const criteria = task.acceptanceCriteria.map(id => { const value = byId.get(id)!; return { ...value, evidenceIds: [...value.evidenceIds].sort() }; });
  const normalized = taskEvaluationSchema.parse({ ...evaluation, criteria });
  const conclusion: 'pass' | 'fail' | 'unknown' = criteria.some(value => value.verdict === 'fail') ? 'fail' : criteria.some(value => value.verdict === 'unknown') ? 'unknown' : 'pass';
  return Object.freeze({ evaluation: normalized, conclusion });
}
