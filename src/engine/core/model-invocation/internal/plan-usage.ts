import { isDeepStrictEqual } from 'node:util';
import { modelInvocationPlanUsageSchema, MODEL_INVOCATION_NATIVE_JSON_LIMITS, type JsonObject, type ModelInvocationPlanUsage } from '#domain/index.js';
import { providerSpendEvidenceDigest, providerSpendOutcomeDigest } from '#engine/core/provider-spend/index.js';
import { ModelInvocationStoreError, type ModelInvocationRecord } from './port.js';

/** Retain provider counters only, never CLI cost estimates, text or a fabricated monetary zero. */
function counters(input: JsonObject | null, depth = 0): JsonObject | null {
  if (!input || depth > MODEL_INVOCATION_NATIVE_JSON_LIMITS.maxDepth) return null;
  const rows: [string, number | JsonObject][] = [];
  for (const [key, value] of Object.entries(input)) {
    if (/cost|price|currency|usd/iu.test(key)) continue;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) rows.push([key, value]);
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = counters(value as JsonObject, depth + 1); if (nested) rows.push([key, nested]);
    }
  }
  return rows.length ? Object.freeze(Object.fromEntries(rows)) as JsonObject : null;
}
export function createModelInvocationPlanUsage(record: ModelInvocationRecord): ModelInvocationPlanUsage | null {
  const { receipt, content } = record, outcome = receipt.outcome;
  if (receipt.profile.schemaVersion !== 2 || receipt.profile.billingAxis !== 'subscription' || !outcome) return null;
  const reported = outcome.state === 'responded' && content?.kind === 'native-response' ? counters(content.response.usage) : null;
  return modelInvocationPlanUsageSchema.parse({ schemaVersion: 1, kind: 'plan-usage', scopeId: receipt.claim.scopeId,
    invocationId: receipt.claim.invocationId, profileDigest: receipt.profileDigest, outcomeDigest: providerSpendOutcomeDigest(receipt),
    observedAtMs: outcome.observedAtMs, source: reported ? 'provider-reported' : 'unavailable', counters: reported });
}
export const modelInvocationPlanUsageDigest = (usage: ModelInvocationPlanUsage) => providerSpendEvidenceDigest(usage);
export function verifyModelInvocationPlanUsage(input: unknown, record: ModelInvocationRecord, checkCounters = true): ModelInvocationPlanUsage | null {
  const expected = createModelInvocationPlanUsage(record);
  if (input === null && expected === null) return null;
  const parsed = modelInvocationPlanUsageSchema.safeParse(input);
  if (!expected || !parsed.success || (record.receipt.outcome?.state !== 'responded' && parsed.data.counters !== null) || !isDeepStrictEqual({ ...parsed.data, counters: null, source: null }, { ...expected, counters: null, source: null })
    || (checkCounters && !record.purge && !isDeepStrictEqual(parsed.data, expected))) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  return parsed.data;
}
