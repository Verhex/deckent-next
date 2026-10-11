import { z } from 'zod';
import { attemptIdentitySchema, sameAttemptIdentity } from '#domain/core/attempt/index.js';
import { identitySchema } from '#domain/core/primitives/index.js';
import { runSnapshotSchema } from './contract.js';
import { taskAcceptanceReferenceSchema, acceptanceCriterionSchema, AcceptanceProfileError } from './acceptance.js';

export const acceptanceViewSchema = z.object({ workClass: identitySchema.nullable(), policyRevision: identitySchema.nullable(),
  profileVersion: z.number().int().positive().nullable(), evaluationId: identitySchema.nullable(),
  criteria: z.array(acceptanceCriterionSchema).readonly(),
  outcome: z.enum(['accepted', 'failed', 'awaiting-decision', 'incomplete']),
  score: z.number().finite().min(0).max(1).nullable(),
  ceilingReasons: z.array(z.enum(['missing-evidence', 'unsettled-effect', 'missing-approval'])).max(3).readonly(),
}).strict().readonly();
export const evaluationAcceptanceSchema = taskAcceptanceReferenceSchema.unwrap().innerType().extend({
  score: z.number().finite().min(0).max(1),
  ceilingReasons: acceptanceViewSchema.unwrap().shape.ceilingReasons,
}).strict().readonly();
/** Structural projection of the canonical evaluation's metadata, not another stored evaluation or verdict. */
const canonicalMetadataSchema = z.object({ identity: attemptIdentitySchema, evaluationId: identitySchema,
  acceptance: evaluationAcceptanceSchema.optional(),
}).passthrough();
export function deriveAcceptanceView(input: unknown, taskId: string, evaluationInput?: unknown): AcceptanceView {
  const run = runSnapshotSchema.parse(input), progress = run.progress.find(row => row.taskId === taskId);
  if (!progress) throw new AcceptanceProfileError();
  const reference = run.execution.tasks.find(row => row.taskId === taskId)?.acceptance;
  const evaluation = evaluationInput === undefined ? undefined : canonicalMetadataSchema.parse(evaluationInput);
  const binding = run.bindings.find(row => row.identity.taskId === taskId);
  if (evaluation && (!binding || !sameAttemptIdentity(binding.identity, evaluation.identity)
    || (!!reference !== !!evaluation.acceptance) || (reference && JSON.stringify(reference) !== JSON.stringify({ workClass: evaluation.acceptance!.workClass,
      policyRevision: evaluation.acceptance!.policyRevision, profileVersion: evaluation.acceptance!.profileVersion, criteria: evaluation.acceptance!.criteria })))) {
    throw new AcceptanceProfileError();
  }
  const metadata = evaluation?.acceptance;
  const phase = progress.phase;
  return acceptanceViewSchema.parse({ workClass: metadata?.workClass ?? reference?.workClass ?? null,
    policyRevision: metadata?.policyRevision ?? reference?.policyRevision ?? null, profileVersion: metadata?.profileVersion ?? reference?.profileVersion ?? null,
    evaluationId: evaluation?.evaluationId ?? null, criteria: metadata?.criteria ?? reference?.criteria ?? [],
    outcome: ['accepted', 'failed', 'awaiting-decision'].includes(phase) ? phase : 'incomplete', score: metadata?.score ?? null,
    ceilingReasons: progress.unresolvedEffects ? ['unsettled-effect'] : metadata?.ceilingReasons ?? [] });
}
export type AcceptanceView = z.infer<typeof acceptanceViewSchema>;
