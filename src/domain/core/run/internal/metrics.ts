import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { exactModelIdSchema, modelUsageEvidenceSchema, workerEffortSchema } from '#domain/core/provider-catalog/index.js';
import { assignmentEffortSourceSchema, assignmentPolicyReferenceSchema } from './assignment.js';
/** DECKENT-METRICS is evidence metadata, never an acceptance command or a new state writer.
 * Each row is attributed to an exact scoped Attempt; a Run incomplete observation is explicitly distinguished from a Task result. */
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const measuredCostSchema = z.object({ basis: z.literal('measured-tariff'),
  amountUsdNanos: z.string().regex(/^(0|[1-9][0-9]*)$/).max(128), tariffDigest: digestSchema,
}).strict().readonly();
const common = {
  identity: z.object({ scopeId: identitySchema, runId: identitySchema, taskId: identitySchema, attemptId: identitySchema }).strict().readonly(),
  workClass: identitySchema.nullable(), policyRevision: identitySchema.nullable(),
  profileVersion: counterSchema.positive().nullable(), skillSetDigest: digestSchema.nullable(),
  model: z.object({ channelId: identitySchema, modelId: exactModelIdSchema }).strict().readonly().nullable(),
  durationMs: counterSchema.positive().nullable(), cost: measuredCostSchema.nullable(),
  attemptSequence: counterSchema.positive(),
  evidenceReferences: z.array(z.object({ id: identitySchema, digest: digestSchema }).strict().readonly()).max(1024).readonly(),
};
const consistent = (value: { workClass: string | null; policyRevision: string | null; evidenceReferences: readonly { id: string }[] }) =>
  (value.workClass === null) === (value.policyRevision === null) && new Set(value.evidenceReferences.map(row => row.id)).size === value.evidenceReferences.length;
const legacyMetricsSchema = z.object({ schemaVersion: z.literal(1), ...common,
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('task'), status: z.enum(['accepted', 'failed', 'awaiting-decision']) }).strict(),
    z.object({ kind: z.literal('run'), status: z.literal('incomplete') }).strict(),
  ]).readonly(),
}).strict().refine(consistent).readonly();
/** What the verdict rests on (law 1): the installed evaluators' evidence kinds plus a human decision; `unknown` for an unlisted evaluator. */
export const METRIC_EVIDENCE_KINDS = ['exit-code', 'human-decision', 'operation-record', 'unknown'] as const;
const label = z.string().min(1).max(64);
/** ATAMA-0 v2 (owner A1/A5, ASS1): effort, the worker-reported model with its evidence label (a report, never provider attestation),
 * container duration, evidence kinds, rubric score, human decisions and quota parks. One current row per (Task, Attempt, outcome kind)
 * is a ledger invariant; replay of a producer is byte-identical. */
const currentMetricsSchema = z.object({ schemaVersion: z.literal(2), ...common,
  effort: workerEffortSchema.nullable(),
  actualModel: z.object({ reported: z.string().min(1).max(256).nullable(), verdict: label, evidence: z.enum(['sealed', 'absent']),
    capability: modelUsageEvidenceSchema }).strict().readonly().nullable(),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('task'), status: z.enum(['accepted', 'failed', 'awaiting-decision']), decision: z.enum(['system', 'human']) }).strict(),
    z.object({ kind: z.literal('run'), status: z.literal('incomplete') }).strict(),
    z.object({ kind: z.literal('quota-park'), channelId: z.string().min(1).max(256) }).strict(),
  ]).readonly(),
  evidenceKinds: z.array(z.enum(METRIC_EVIDENCE_KINDS)).max(METRIC_EVIDENCE_KINDS.length).readonly(),
  acceptanceScore: z.number().finite().min(0).max(1).nullable(),
  /** ATAMA-1: how the system chose this Attempt's worker (from the Run's sealed assignment); absent for a pinned model and on earlier rows. */
  assignment: z.object({ candidatePolicy: assignmentPolicyReferenceSchema, candidateIndex: counterSchema,
    workClassRevision: identitySchema, catalogRevision: identitySchema, modelRevision: counterSchema.positive(), activationRevision: counterSchema.positive(),
    effortSource: assignmentEffortSourceSchema }).strict().readonly().optional(),
}).strict().refine(value => consistent(value) && new Set(value.evidenceKinds).size === value.evidenceKinds.length
  && value.evidenceKinds.every((kind, index) => index === 0 || value.evidenceKinds[index - 1]! < kind)).readonly();
export const deckentMetricsSchema = z.union([legacyMetricsSchema, currentMetricsSchema]);
export type DeckentMetrics = z.infer<typeof deckentMetricsSchema>;
export type CurrentDeckentMetrics = z.infer<typeof currentMetricsSchema>;
const measurementsSchema = z.object({ startedAtMs: counterSchema.nullable().optional(), endedAtMs: counterSchema.nullable().optional(),
  cost: measuredCostSchema.nullable().optional(),
  /** A human decision row carries the duration its system row already measured; it is never combined with a clock interval. */
  carriedDurationMs: counterSchema.positive().nullable().optional(),
}).strict().readonly();
export type DeckentMetricsMeasurements = z.infer<typeof measurementsSchema>;
/** No clock, tariff lookup or inferred acceptance here. Caller supplies canonical result/custody and pinned measurements.
 * Missing, equal or reversed clock intervals remain null; exact monetary zero requires an explicit measured-tariff record.
 * New rows are always v2; v1 rows stay readable and are never rewritten. */
export function deriveDeckentMetrics(input: Omit<CurrentDeckentMetrics, 'schemaVersion' | 'durationMs' | 'cost'>,
  measurements: DeckentMetricsMeasurements = {}): CurrentDeckentMetrics {
  const measured = measurementsSchema.parse(measurements);
  const { startedAtMs, endedAtMs } = measured;
  const durationMs = startedAtMs != null && endedAtMs != null && endedAtMs > startedAtMs ? endedAtMs - startedAtMs : measured.carriedDurationMs ?? null;
  return currentMetricsSchema.parse({ ...input, schemaVersion: 2, durationMs, cost: measured.cost ?? null,
    evidenceKinds: [...new Set(input.evidenceKinds)].sort(),
    evidenceReferences: [...input.evidenceReferences].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0) });
}
