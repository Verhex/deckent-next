import { MODEL_INVOCATION_NATIVE_JSON_LIMITS } from './contract.js';
import { z } from 'zod';
import { counterSchema, identitySchema, immutableJsonObjectSchema } from '#domain/core/primitives/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Non-monetary evidence: no currency, quote, reservation or charged amount. */
export const modelInvocationPlanUsageSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('plan-usage'),
  scopeId: identitySchema, invocationId: identitySchema, profileDigest: digest, outcomeDigest: digest,
  observedAtMs: counterSchema, source: z.enum(['provider-reported', 'unavailable']), counters: immutableJsonObjectSchema.nullable(),
}).strict().superRefine((value, context) => {
  const valid = (row: Readonly<Record<string, unknown>>, depth: number): boolean => depth <= MODEL_INVOCATION_NATIVE_JSON_LIMITS.maxDepth && Object.entries(row).every(([key, item]) =>
    !/cost|price|currency|usd/iu.test(key) && (typeof item === 'number' ? Number.isSafeInteger(item) && item >= 0
      : !!item && typeof item === 'object' && !Array.isArray(item) && valid(item as Readonly<Record<string, unknown>>, depth + 1)));
  if ((value.counters === null) !== (value.source === 'unavailable')) context.addIssue({ code: z.ZodIssueCode.custom, message: 'PLAN_USAGE_SOURCE_INVALID' });
  if (value.counters !== null && !valid(value.counters, 0)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'PLAN_USAGE_COUNTER_INVALID' });
}).readonly();
export type ModelInvocationPlanUsage = z.infer<typeof modelInvocationPlanUsageSchema>;
