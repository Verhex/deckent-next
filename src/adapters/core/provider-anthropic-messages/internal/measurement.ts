import type { ModelInvocationNativeResponse, ProviderSpendQuote } from '#domain/index.js';
import { parseProviderSpendTariffMeasurement, providerSpendQuoteDigest, modelInvocationResponseContentDescriptor } from '#engine/index.js';
import { anthropicTariffSchema } from './contract.js';
import { anthropicSettledCharge } from './tariff.js';
import type { AnthropicUsage } from './assemble.js';
export function anthropicUsageForSpending(usage: AnthropicUsage) {
  if (usage.input_tokens == null) return null;
  const prompt = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), output = usage.output_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
    anthropic: { input_tokens: usage.input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0, cache_creation: usage.cache_creation ?? null } };
}
export function anthropicSpendMeasurement(quote: ProviderSpendQuote, usage: unknown, responseContentDigest: string) {
  const tariff = anthropicTariffSchema.parse(quote.pricing.definition), charge = anthropicSettledCharge(tariff, usage);
  return parseProviderSpendTariffMeasurement({ schemaVersion: 1, basis: 'measured-tariff', currency: quote.currency,
    exactMinorUnits: charge.exactMinorUnits, roundedMinorUnits: charge.roundedMinorUnits,
    quoteDigest: providerSpendQuoteDigest(quote), requestDigest: quote.requestDigest, profileDigest: quote.profileDigest,
    responseContentDigest, source: { id: 'anthropic-usage-tariff', version: 1, modelId: tariff.modelId, tariffDigest: quote.pricing.digest,
      tier: charge.tier, dimensions: charge.dimensions, cacheSplit: charge.cacheSplit } });
}
export function anthropicResponseSpendMeasurement(quote: ProviderSpendQuote, response: ModelInvocationNativeResponse) {
  return response.usage === null ? null : anthropicSpendMeasurement(quote, response.usage, modelInvocationResponseContentDescriptor(response).digest);
}
