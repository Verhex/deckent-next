import { createHash } from 'node:crypto';
import type { JsonObject, ModelInvocationNativeResponse } from '#domain/index.js';
import { parseOpenRouterReportedCharge } from '#adapters/core/provider-openrouter-pricing/index.js';
import { OpenRouterChatError, openRouterChatJsonSchema } from './contract.js';

export interface OpenRouterUsageContext {
  readonly profileDigest: string; readonly tariffDigest: string; readonly requestBodyDigest: string;
  /** Requested route, not evidence that the response identifies a particular provider region. */
  readonly selectedEndpointTag: string;
}
export type OpenRouterUsageObservation = Readonly<{
  kind: 'reported'; evidence: Readonly<{
    schemaVersion: 1; basis: 'provider-reported'; currency: 'USD'; exactChargeUsd: string;
    roundedChargeMinorUnits: number; rounding: 'ceil-total'; usage: JsonObject; context: Readonly<OpenRouterUsageContext>;
    source: Readonly<{ field: 'usage.cost'; numericSource: string; bodyDigest: string; responseDigest: string;
      generationId: string; modelId: string }>;
  }>;
}> | Readonly<{ kind: 'hold'; reason: 'missing-usage' | 'missing-cost' | 'invalid-cost' }>;

export function openRouterResponseDigest(response: ModelInvocationNativeResponse): string {
  const parsed = openRouterChatJsonSchema.safeParse(response);
  if (!parsed.success) throw new OpenRouterChatError('INVALID_REQUEST');
  return createHash('sha256').update(`deckent.openrouter.native-response.v1\n${JSON.stringify(parsed.data)}`).digest('hex');
}

/** Called only on a complete, validated response. This observes an account charge; it cannot release funds.
 * USD credits: https://openrouter.ai/support/ ; field: /docs/cookbook/administration/usage-accounting.
 * Keep raw numeric source: JSON Number conversion can erase tiny positive charges and rounding boundaries.
 * Node >=24 (the package engine) supplies reviver context.source. Absence fails closed.
 */
export function observeOpenRouterUsage(body: Buffer, response: ModelInvocationNativeResponse, context: OpenRouterUsageContext): OpenRouterUsageObservation {
  const hold = (reason: 'missing-usage' | 'missing-cost' | 'invalid-cost') => Object.freeze({ kind: 'hold' as const, reason });
  if (response.usage === null) return hold('missing-usage');
  const sources = new WeakMap<object, string>();
  let raw: { usage?: unknown };
  try {
    raw = JSON.parse(body.toString('utf8'), function (this: object, key: string, value: unknown, context?: { source?: string }) {
      if (key === 'cost' && typeof value === 'number' && typeof context?.source === 'string') sources.set(this, context.source);
      return value;
    }) as { usage?: unknown };
  } catch { return hold('invalid-cost'); }
  const usage = raw?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return hold('invalid-cost');
  if (!Object.hasOwn(usage, 'cost')) return hold('missing-cost');
  const numericSource = sources.get(usage);
  if (!numericSource || typeof (usage as { cost?: unknown }).cost !== 'number') return hold('invalid-cost');
  try {
    const charge = parseOpenRouterReportedCharge(numericSource);
    if (typeof response.native.id !== 'string' || typeof response.native.model !== 'string') return hold('invalid-cost');
    return Object.freeze({ kind: 'reported', evidence: Object.freeze({ schemaVersion: 1, basis: 'provider-reported',
      currency: 'USD', ...charge, rounding: 'ceil-total', usage: response.usage, context: Object.freeze({ ...context }),
      source: Object.freeze({ field: 'usage.cost', numericSource, bodyDigest: createHash('sha256').update(body).digest('hex'),
        responseDigest: openRouterResponseDigest(response), generationId: response.native.id, modelId: response.native.model }) }) });
  } catch { return hold('invalid-cost'); }
}
