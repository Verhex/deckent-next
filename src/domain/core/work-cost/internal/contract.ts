import { persistedString, persistedInteger, identitySchema } from '#domain/core/primitives/index.js';
import { z } from 'zod';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
import { acceptanceViewSchema, measuredCostSchema } from '#domain/core/run/index.js';
import { costRecommendationSchema } from './recommendation.js';
const value = z.number().nonnegative().finite().nullable();
export const workCostSchema = z.strictObject({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  profile: z.strictObject({ id: identitySchema, version: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }).readonly(),
  model: z.strictObject({ channelId: identitySchema, modelId: persistedString(z.string().min(1)), evidence: z.enum(['requested', 'verified', 'unknown']) }).readonly().nullable(),
  effort: z.string().nullable(), acceptance: acceptanceViewSchema,
  axes: z.strictObject({ cpuSeconds: value, sampledPeakBytes: value, kernelPeakBytes: value, wallMs: value,
    apiMoney: measuredCostSchema.nullable(),
    subscription: z.strictObject({ calls: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(), durationMs: value, limit: z.null() }).readonly().nullable(),
    localModel: z.strictObject({ calls: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(), durationMs: value }).readonly().nullable(),
    humanInterventions: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
  }).readonly(),
  quality: z.strictObject({ reworkCount: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(), rollbackCount: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
    interventionCount: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(), followup: z.enum(['unknown', 'open', 'complete']) }).readonly(),
  coverage: z.literal('partial'), sampleCount: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), gapCount: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
}).readonly();
export type WorkCost = z.infer<typeof workCostSchema>;
export const workCostReportSchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema, runId: identitySchema,
  recommendations: z.array(costRecommendationSchema).readonly().optional(),
  recommendationsTruncated: z.boolean().optional(),
  runRevision: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), observedAtMs: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  coverage: z.literal('partial'), withheld: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  attempts: z.array(workCostSchema).readonly(),
  summary: z.strictObject({ acceptedTasks: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), failedTasks: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    unknownTasks: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), measuredCpuSeconds: value, sampledPeakBytes: value,
    measuredApiUsdNanos: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(), unknownApiAttempts: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    sampledCpuSecondsPerAcceptedTask: value,
  }).readonly(),
}).readonly();
export type WorkCostReport = z.infer<typeof workCostReportSchema>;
