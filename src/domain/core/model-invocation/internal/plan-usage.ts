import { MODEL_INVOCATION_NATIVE_JSON_LIMITS } from './contract.js';
import { z } from 'zod';
import { nativeCallObservationSchema } from './observation.js';
import { counterSchema, identitySchema, immutableJsonObjectSchema } from '#domain/core/primitives/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Non-monetary evidence: no currency, quote, reservation or charged amount. */
const fields = { kind: z.literal('plan-usage'),
  scopeId: identitySchema, invocationId: identitySchema, profileDigest: digest, outcomeDigest: digest,
  observedAtMs: counterSchema, source: z.enum(['provider-reported', 'unavailable']), counters: immutableJsonObjectSchema.nullable(),
};
const validateCounters = (value: { counters: Readonly<Record<string, unknown>> | null; source: string }, context: z.RefinementCtx) => {
  const valid = (row: Readonly<Record<string, unknown>>, depth: number): boolean => depth <= MODEL_INVOCATION_NATIVE_JSON_LIMITS.maxDepth && Object.entries(row).every(([key, item]) =>
    !/cost|price|currency|usd/iu.test(key) && (typeof item === 'number' ? Number.isSafeInteger(item) && item >= 0
      : !!item && typeof item === 'object' && !Array.isArray(item) && valid(item as Readonly<Record<string, unknown>>, depth + 1)));
  if ((value.counters === null) !== (value.source === 'unavailable')) context.addIssue({ code: z.ZodIssueCode.custom, message: 'PLAN_USAGE_SOURCE_INVALID' });
  if (value.counters !== null && !valid(value.counters, 0)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'PLAN_USAGE_COUNTER_INVALID' });
};
export const modelInvocationPlanUsageSchema = z.strictObject({ schemaVersion: z.literal(1), ...fields }).superRefine(validateCounters).readonly();
export type ModelInvocationPlanUsage = z.infer<typeof modelInvocationPlanUsageSchema>;
/** Reader only: production writers retain the v1 schema and bytes. */
export const modelInvocationPlanUsageReadSchema = z.union([modelInvocationPlanUsageSchema,
  z.strictObject({ ...fields, schemaVersion: z.literal(2), observation: nativeCallObservationSchema.nullable() }).superRefine(validateCounters).readonly()]);
export type ModelInvocationPlanUsageRead = z.infer<typeof modelInvocationPlanUsageReadSchema>;
