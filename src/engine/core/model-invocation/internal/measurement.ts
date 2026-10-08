import type { ModelInvocationNativeResponse, ProviderSpendQuote } from '#domain/index.js';
import { parseProviderSpendMeasurement, providerSpendQuoteDigest, type ProviderSpendMeasurement } from '#engine/core/provider-spend/index.js';
import { modelInvocationResponseContentDescriptor } from './content.js';
import type { ModelInvocationNativePort } from './application.js';

/** Observation failures retain money; a valid model response is still recorded. The store independently checks correlation. */
export function observeModelInvocationSpending(native: ModelInvocationNativePort, prepared: unknown,
  response: ModelInvocationNativeResponse, quote: ProviderSpendQuote): ProviderSpendMeasurement | null {
  if (!native.observeSpending) return null;
  try {
    const observed = native.observeSpending(prepared, response);
    if (observed === null) return null;
    const measurement = parseProviderSpendMeasurement(observed);
    if (measurement.quoteDigest !== providerSpendQuoteDigest(quote) || measurement.currency !== quote.currency
      || measurement.profileDigest !== quote.profileDigest || measurement.requestDigest !== quote.requestDigest
      || measurement.source.tariffDigest !== quote.pricing.digest
      || measurement.responseContentDigest !== modelInvocationResponseContentDescriptor(response).digest) return null;
    return measurement;
  } catch { return null; }
}

export function observeModelInvocationPartialSpending(native: ModelInvocationNativePort, prepared: unknown,
  contentDigest: string, quote: ProviderSpendQuote): ProviderSpendMeasurement | null {
  if (!native.observePartialSpending) return null;
  try {
    const raw = native.observePartialSpending(prepared, contentDigest);
    if (!raw) return null;
    const value = parseProviderSpendMeasurement(raw);
    if (value.quoteDigest !== providerSpendQuoteDigest(quote) || value.currency !== quote.currency
      || value.profileDigest !== quote.profileDigest || value.requestDigest !== quote.requestDigest
      || value.source.tariffDigest !== quote.pricing.digest || value.responseContentDigest !== contentDigest) return null;
    return value;
  } catch { return null; }
}
