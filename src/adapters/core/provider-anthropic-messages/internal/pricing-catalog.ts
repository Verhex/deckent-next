import { z } from 'zod';
import pricing from './pricing.json' with { type: 'json' };
import { anthropicTariffSchema, type AnthropicPublishedTariff } from './contract.js';

const rates = { input: z.string(), cacheWrite5m: z.string(), cacheWrite1h: z.string(), cacheRead: z.string(), output: z.string() };
const sourceSchema = z.object({ url: z.string(), retrievedAt: z.string() }).strict();
/** Registry v2 (2026-10-08): optional per-row `promptTiers` and `source`. Values are checked by the tariff schema each row becomes. */
const registrySchema = z.object({ schemaVersion: z.literal(2), currency: z.literal('USD'), unit: z.string(), source: sourceSchema,
  promptTokenBasis: z.literal('input+cache-write+cache-read'), note: z.string(),
  models: z.array(z.object({ modelId: z.string(), ...rates, promptTiers: z.array(z.object({ aboveTokens: z.number(), ...rates }).strict()).min(1).optional(),
    source: sourceSchema.optional() }).strict()).min(1) }).strict()
  .refine(registry => new Set(registry.models.map(row => row.modelId)).size === registry.models.length);

/** Old/missing shapes fail with ZodError at load; the shipped file is one versioned document, never silently defaulted. */
const registry = registrySchema.parse(pricing);
/**
 * Published Claude API prices (`pricing.json`, dated and sourced per row). Data, not policy: an operator copies the row of the pinned model
 * into the profile's `tariff`, so a later price change is a new profile version and never a silent code change. A flat row becomes a v1
 * tariff (unchanged shape and digest), a row with prompt-length tiers a v2 tariff. Every row is validated by the schema the profile uses.
 */
export const ANTHROPIC_PUBLISHED_TARIFFS: readonly AnthropicPublishedTariff[] = Object.freeze(registry.models.map(({ modelId, promptTiers, source, ...usdPerMTok }) =>
  Object.freeze(anthropicTariffSchema.parse(promptTiers === undefined
    ? { kind: 'anthropic-published', version: 1, currency: registry.currency, modelId, usdPerMTok, source: source ?? registry.source }
    : { kind: 'anthropic-published', version: 2, currency: registry.currency, modelId, usdPerMTok, source: source ?? registry.source,
      promptTokenBasis: registry.promptTokenBasis,
      promptTiers: promptTiers.map(({ aboveTokens, ...tierRates }) => ({ aboveTokens, usdPerMTok: tierRates })) }))));
export function anthropicPublishedTariff(modelId: string): AnthropicPublishedTariff | undefined {
  return ANTHROPIC_PUBLISHED_TARIFFS.find(tariff => tariff.modelId === modelId);
}
