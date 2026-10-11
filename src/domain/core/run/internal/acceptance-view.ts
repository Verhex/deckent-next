import { z } from 'zod';
import { attemptIdentitySchema, sameAttemptIdentity } from '#domain/core/attempt/index.js';
import { identitySchema } from '#domain/core/primitives/index.js';
import { runSnapshotSchema } from './contract.js';
import { taskAcceptanceReferenceSchema, acceptanceCriterionSchema, AcceptanceProfileError } from './acceptance.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Canonical criterion outcome, shared by evaluation storage and every inspection surface. */
export const evaluationCriterionSchema = z.object({ criterionId: identitySchema, verdict: z.enum(['pass', 'fail', 'unknown']),
  evidenceIds: z.array(identitySchema).readonly(),
  evidenceTypes: z.array(z.string().min(1).max(256)).max(256).refine(value => new Set(value).size === value.length).readonly().optional(),
  evidenceReferences: z.array(z.object({ id: identitySchema, digest }).strict().readonly()).max(256).readonly().optional(),
  reason: z.enum(['EFFECT_PRECONDITION_CHANGED', 'EFFECT_REJECTED', 'OPERATION_EVIDENCE_UNAVAILABLE', 'OPERATION_EVIDENCE_MISSING',
    'OPERATION_EVIDENCE_INVALID', 'OPERATION_EVIDENCE_BINDING', 'OPERATION_EVIDENCE_UNSETTLED', 'OPERATION_EVIDENCE_COMPENSATED',
    'OPERATION_EVIDENCE_CONTEXT', 'OPERATION_EVIDENCE_EARLIER', 'OPERATION_EVIDENCE_PRINCIPAL', 'OPERATION_EVIDENCE_REUSED',
    'OPERATION_COMPENSATION_UNAVAILABLE', 'OPERATION_COMPENSATION_INVALID', 'OPERATION_COMPENSATION_BINDING', 'OPERATION_COMPENSATION_UNSETTLED']).optional(),
  /** State observation is not settlement proof: null digest records absence, and unknown still cannot pass. */
  effectEvidence: z.object({ commandId: identitySchema, digest: digest.nullable(),
    compensation: z.object({ commandId: identitySchema, digest }).strict().readonly().nullable(),
  }).strict().readonly().optional(),
}).strict().superRefine((value, context) => {
  if ((value.verdict !== 'unknown' && value.evidenceIds.length === 0) || new Set(value.evidenceIds).size !== value.evidenceIds.length
    || (value.verdict === 'pass' && value.reason !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'TASK_EVALUATION_INVALID' });
}).readonly();
export const acceptanceViewSchema = z.object({ workClass: identitySchema.nullable(), policyRevision: identitySchema.nullable(),
  profileVersion: z.number().int().positive().nullable(), evaluationId: identitySchema.nullable(),
  criteria: z.array(acceptanceCriterionSchema).readonly(),
  outcome: z.enum(['accepted', 'failed', 'awaiting-decision', 'incomplete']),
  score: z.number().finite().min(0).max(1).nullable(),
  ceilingReasons: z.array(z.enum(['missing-evidence', 'unsettled-effect', 'missing-approval'])).max(3).readonly(),
  results: z.array(evaluationCriterionSchema).readonly().optional(),
}).strict().readonly();
export const evaluationAcceptanceSchema = taskAcceptanceReferenceSchema.unwrap().innerType().extend({
  score: z.number().finite().min(0).max(1),
  ceilingReasons: acceptanceViewSchema.unwrap().shape.ceilingReasons,
}).strict().readonly();
/** Structural projection of the canonical evaluation's metadata, not another stored evaluation or verdict. */
const canonicalMetadataSchema = z.object({ identity: attemptIdentitySchema, evaluationId: identitySchema,
  acceptance: evaluationAcceptanceSchema.optional(),
  criteria: z.array(evaluationCriterionSchema).readonly().optional(),
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
    ceilingReasons: progress.unresolvedEffects ? ['unsettled-effect'] : metadata?.ceilingReasons ?? [],
    ...(evaluation?.criteria?.some(row => row.reason !== undefined || row.effectEvidence !== undefined) ? { results: evaluation.criteria } : {}) });
}
export type AcceptanceView = z.infer<typeof acceptanceViewSchema>;
