import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { exactModelIdSchema } from '#domain/core/provider-catalog/index.js';
/** DECKENT-METRICS v1 is evidence metadata, never an acceptance command or a new state writer.
 * Each row is attributed to an exact scoped Attempt; a Run incomplete observation is explicitly distinguished from a Task result. */
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const measuredCostSchema = z.object({ basis: z.literal('measured-tariff'),
  amountUsdNanos: z.string().regex(/^(0|[1-9][0-9]*)$/).max(128), tariffDigest: digestSchema,
}).strict().readonly();
export const deckentMetricsSchema = z.object({ schemaVersion: z.literal(1),
  identity: z.object({ scopeId: identitySchema, runId: identitySchema, taskId: identitySchema, attemptId: identitySchema }).strict().readonly(),
  workClass: identitySchema.nullable(), policyRevision: identitySchema.nullable(),
  profileVersion: counterSchema.positive().nullable(), skillSetDigest: digestSchema.nullable(),
  model: z.object({ channelId: identitySchema, modelId: exactModelIdSchema }).strict().readonly().nullable(),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('task'), status: z.enum(['accepted', 'failed', 'awaiting-decision']) }).strict(),
    z.object({ kind: z.literal('run'), status: z.literal('incomplete') }).strict(),
  ]).readonly(),
  durationMs: counterSchema.positive().nullable(), cost: measuredCostSchema.nullable(),
  attemptSequence: counterSchema.positive(),
  evidenceReferences: z.array(z.object({ id: identitySchema, digest: digestSchema }).strict().readonly()).max(1024).readonly(),
}).strict().refine(value => (value.workClass === null) === (value.policyRevision === null)
  && new Set(value.evidenceReferences.map(row => row.id)).size === value.evidenceReferences.length).readonly();
export type DeckentMetrics = z.infer<typeof deckentMetricsSchema>;
const measurementsSchema = z.object({ startedAtMs: counterSchema.nullable().optional(), endedAtMs: counterSchema.nullable().optional(),
  cost: measuredCostSchema.nullable().optional(),
}).strict().readonly();
export type DeckentMetricsMeasurements = z.infer<typeof measurementsSchema>;
/** No clock, tariff lookup or inferred acceptance here. Caller supplies canonical result/custody and pinned measurements.
 * Missing, equal or reversed clock intervals remain null; exact monetary zero requires an explicit measured-tariff record. */
export function deriveDeckentMetrics(input: Omit<DeckentMetrics, 'schemaVersion' | 'durationMs' | 'cost'>,
  measurements: DeckentMetricsMeasurements = {}): DeckentMetrics {
  const measured = measurementsSchema.parse(measurements);
  const { startedAtMs, endedAtMs } = measured;
  const durationMs = startedAtMs != null && endedAtMs != null && endedAtMs > startedAtMs ? endedAtMs - startedAtMs : null;
  return deckentMetricsSchema.parse({ ...input, schemaVersion: 1, durationMs, cost: measured.cost ?? null,
    evidenceReferences: [...input.evidenceReferences].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0) });
}
