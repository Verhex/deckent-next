import { counterSchema, persistedString, persistedInteger, identitySchema } from '#domain/core/primitives/index.js';
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
    subscription: z.strictObject({ calls: counterSchema.nullable(), durationMs: value, limit: z.null() }).readonly().nullable(),
    localModel: z.strictObject({ calls: counterSchema.nullable(), durationMs: value }).readonly().nullable(),
    humanInterventions: counterSchema.nullable(),
  }).readonly(),
  quality: z.strictObject({ reworkCount: counterSchema.nullable(), rollbackCount: counterSchema.nullable(),
    interventionCount: counterSchema.nullable(), followup: z.enum(['unknown', 'open', 'complete']) }).readonly(),
  coverage: z.literal('partial'), sampleCount: counterSchema, gapCount: counterSchema,
}).readonly();
export type WorkCost = z.infer<typeof workCostSchema>;
export const workCostReportSchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema, runId: identitySchema,
  recommendations: z.array(costRecommendationSchema).readonly().optional(),
  recommendationsTruncated: z.boolean().optional(),
  runRevision: counterSchema, observedAtMs: counterSchema,
  coverage: z.literal('partial'), withheld: counterSchema,
  attempts: z.array(workCostSchema).readonly(),
  summary: z.strictObject({ acceptedTasks: counterSchema, failedTasks: counterSchema,
    unknownTasks: counterSchema, measuredCpuSeconds: value, sampledPeakBytes: value,
    measuredApiUsdNanos: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(), unknownApiAttempts: counterSchema,
    sampledCpuSecondsPerAcceptedTask: value,
  }).readonly(),
}).readonly();
export type WorkCostReport = z.infer<typeof workCostReportSchema>;
