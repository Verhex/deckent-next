import { z } from 'zod';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
import { identitySchema } from '#domain/core/primitives/index.js';
import { acceptanceViewSchema, deckentMetricsSchema } from '#domain/core/run/index.js';
import { costRecommendationSchema } from './recommendation.js';
const value = z.number().nonnegative().finite().nullable();
export const workCostSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  profile: z.object({ id: identitySchema, version: z.number().int().positive().safe() }).strict().readonly(),
  model: z.object({ channelId: identitySchema, modelId: z.string().min(1), evidence: z.enum(['requested', 'verified', 'unknown']) }).strict().readonly().nullable(),
  effort: z.string().nullable(), acceptance: acceptanceViewSchema,
  axes: z.object({ cpuSeconds: value, sampledPeakBytes: value, kernelPeakBytes: value, wallMs: value,
    apiMoney: deckentMetricsSchema.unwrap().innerType().shape.cost,
    subscription: z.object({ calls: z.number().int().nonnegative().safe().nullable(), durationMs: value, limit: z.null() }).strict().readonly().nullable(),
    localModel: z.object({ calls: z.number().int().nonnegative().safe().nullable(), durationMs: value }).strict().readonly().nullable(),
    humanInterventions: z.number().int().nonnegative().safe().nullable(),
  }).strict().readonly(),
  quality: z.object({ reworkCount: z.number().int().nonnegative().safe().nullable(), rollbackCount: z.number().int().nonnegative().safe().nullable(),
    interventionCount: z.number().int().nonnegative().safe().nullable(), followup: z.enum(['unknown', 'open', 'complete']) }).strict().readonly(),
  coverage: z.literal('partial'), sampleCount: z.number().int().nonnegative().safe(), gapCount: z.number().int().nonnegative().safe(),
}).strict().readonly();
export type WorkCost = z.infer<typeof workCostSchema>;
export const workCostReportSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, runId: identitySchema,
  recommendations: z.array(costRecommendationSchema).readonly().optional(),
  recommendationsTruncated: z.boolean().optional(),
  runRevision: z.number().int().nonnegative().safe(), observedAtMs: z.number().int().nonnegative().safe(),
  coverage: z.literal('partial'), withheld: z.number().int().nonnegative().safe(),
  attempts: z.array(workCostSchema).readonly(),
  summary: z.object({ acceptedTasks: z.number().int().nonnegative().safe(), failedTasks: z.number().int().nonnegative().safe(),
    unknownTasks: z.number().int().nonnegative().safe(), measuredCpuSeconds: value, sampledPeakBytes: value,
    measuredApiUsdNanos: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(), unknownApiAttempts: z.number().int().nonnegative().safe(),
    sampledCpuSecondsPerAcceptedTask: value,
  }).strict().readonly(),
}).strict().readonly();
export type WorkCostReport = z.infer<typeof workCostReportSchema>;
