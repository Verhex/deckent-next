import type { ModelInvocationNativeResponse, ProviderSpendQuote } from '#domain/index.js';
import { parseProviderSpendReportedMeasurement, providerSpendQuoteDigest, type ProviderSpendReportedMeasurement } from '#engine/core/provider-spend/index.js';
import { modelInvocationResponseContentDescriptor } from './content.js';
import type { ModelInvocationNativePort } from './application.js';

/** Observation failures retain money; a valid model response is still recorded. The store independently checks correlation. */
export function observeModelInvocationSpending(native: ModelInvocationNativePort, prepared: unknown,
  response: ModelInvocationNativeResponse, quote: ProviderSpendQuote): ProviderSpendReportedMeasurement | null {
  if (!native.observeSpending) return null;
  try {
    const observed = native.observeSpending(prepared, response);
    if (observed === null) return null;
    const measurement = parseProviderSpendReportedMeasurement(observed);
    if (measurement.quoteDigest !== providerSpendQuoteDigest(quote) || measurement.currency !== quote.currency
      || measurement.profileDigest !== quote.profileDigest || measurement.requestDigest !== quote.requestDigest
      || measurement.source.tariffDigest !== quote.pricing.digest
      || measurement.responseContentDigest !== modelInvocationResponseContentDescriptor(response).digest) return null;
    return measurement;
  } catch { return null; }
}
