import type { JsonObject } from '#domain/index.js';
import { decimalRate, maxRate, type DecimalRate } from './decimal.js';
import { OpenRouterPricingError } from './error.js';

export const chargeDimensions = ['prompt', 'completion', 'request', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'internal_reasoning'] as const;
export type ChargeDimension = typeof chargeDimensions[number];
export type TariffRates = Readonly<Record<ChargeDimension, DecimalRate>>;
const conditions = ['min_prompt_tokens', 'utc_start', 'utc_end', 'utc_days'];
const unreachable = ['image', 'image_output', 'image_token', 'web_search', 'audio', 'audio_output', 'input_audio_cache'];
const zero = decimalRate('0');

/** Published optional SKUs are additive only when advertised. An omitted cache read is covered by
 * prompt; implicit cache writes use ordinary input pricing; reasoning uses the completion budget.
 * Omission is recorded separately from an explicitly unpriced (null) reachable SKU. Request routing
 * also pins max_price.request to the published fee maximum (zero when no request SKU is advertised).
 * These v2 inclusion rules apply only to the closed text/function request, with plugins disabled.
 */
export function endpointRates(pricing: JsonObject) {
  const priced = new Set<string>(), unpriced = new Set<string>(), included = new Set<string>();
  const parse = (row: JsonObject, override: boolean) => {
    const rates: Partial<Record<ChargeDimension, DecimalRate>> = {};
    for (const [key, value] of Object.entries(row)) {
      if (chargeDimensions.includes(key as ChargeDimension)) {
        if (value === null) { unpriced.add(key); continue; }
        rates[key as ChargeDimension] = decimalRate(value); priced.add(key); continue;
      }
      if (unreachable.includes(key)) continue; // No media or server tools in the closed request contract.
      if (key === 'discount' && typeof value === 'number' && value >= 0 && value <= 1) continue; // Never lowers the envelope.
      if (!override && key === 'overrides') continue;
      if (override && conditions.includes(key)) continue; // Bound every condition; never evaluate or discard a price branch.
      throw new OpenRouterPricingError('UNSUPPORTED_PRICING');
    }
    return rates;
  };
  const base = parse(pricing, false);
  for (const key of ['prompt', 'completion'] as const) if (!Object.hasOwn(pricing, key)) unpriced.add(key);
  for (const key of chargeDimensions) if (!Object.hasOwn(pricing, key) && key !== 'prompt' && key !== 'completion') included.add(key);
  const maximum = Object.fromEntries(chargeDimensions.map(key => [key, base[key] ?? zero])) as Record<ChargeDimension, DecimalRate>;
  if (Object.hasOwn(pricing, 'overrides')) {
    if (!Array.isArray(pricing['overrides'])) throw new OpenRouterPricingError('INVALID_METADATA');
    for (const entry of pricing['overrides']) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new OpenRouterPricingError('INVALID_METADATA');
      const prices = parse(entry, true);
      for (const key of chargeDimensions) maximum[key] = maxRate(maximum[key], prices[key] ?? zero);
    }
  }
  return { rates: Object.freeze(maximum), priced, unpriced, included };
}
