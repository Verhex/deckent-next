import pricing from './pricing.json' with { type: 'json' };
import { anthropicTariffSchema, type AnthropicPublishedTariff } from './contract.js';

/**
 * Published Claude API prices read on 2026-09-28 (`pricing.json`, dated and sourced). Data, not policy: an operator copies the row of
 * the pinned model into the profile's `tariff`, so a later price change is a new profile version and never a silent code change.
 * Every row is validated by the same schema the profile uses.
 */
export const ANTHROPIC_PUBLISHED_TARIFFS: readonly AnthropicPublishedTariff[] = Object.freeze(pricing.models.map(({ modelId, ...rates }) =>
  Object.freeze(anthropicTariffSchema.parse({ kind: 'anthropic-published', version: 1, currency: pricing.currency, modelId, usdPerMTok: rates, source: pricing.source }))));
export function anthropicPublishedTariff(modelId: string): AnthropicPublishedTariff | undefined {
  return ANTHROPIC_PUBLISHED_TARIFFS.find(tariff => tariff.modelId === modelId);
}
