import { z } from 'zod';
import { identitySchema, counterSchema, taskEvaluationSchema, TaskEvaluationError } from '#domain/index.js';
import { dispatchRecordSchema } from '#engine/core/dispatch/index.js';
import type { RunReceipt } from '#engine/core/runs/index.js';

/** Trusted application-to-ledger input, never a public verdict submission API.
 * The dispatch is the exact record whose retained output the application verified.
 * Persistence rechecks it under the same transaction as the Run revision fence.
 */
export const taskEvaluationCommitSchema = z.object({
  commandId: identitySchema,
  actor: z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict(),
  expectedRevision: counterSchema,
  evaluation: taskEvaluationSchema,
  dispatch: dispatchRecordSchema,
}).strict().refine(value => value.commandId === value.evaluation.evaluationId, 'TASK_EVALUATION_INVALID')
  .transform(value => ({ ...value, evaluation: taskEvaluationSchema.parse({ ...value.evaluation,
    criteria: [...value.evaluation.criteria].sort((a, b) => a.criterionId < b.criterionId ? -1 : a.criterionId > b.criterionId ? 1 : 0)
      .map(criterion => ({ ...criterion, evidenceIds: [...criterion.evidenceIds].sort() })),
  }) }));
export type TaskEvaluationCommit = z.infer<typeof taskEvaluationCommitSchema>;
export interface TaskEvaluationStore {
  commitTaskEvaluation(input: TaskEvaluationCommit): Promise<RunReceipt>;
}
/** The application verified this exact custody snapshot; later changes require fresh evaluation. */
export function assertTaskEvaluationCustody(verified: unknown, current: unknown): void {
  if (JSON.stringify(dispatchRecordSchema.parse(verified)) !== JSON.stringify(dispatchRecordSchema.parse(current))) {
    throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  }
}
