import type { ProviderSpendQuote } from '#domain/index.js';

/** Engine vocabulary for operator-declared tariffs: pricing is authored configuration, not a provider price feed. */
export const OPERATOR_TARIFF_PRICING_ID = 'operator-static-tariff' as const;

/**
 * Local settlement amount for a responded invocation priced by an operator tariff whose verified bound is zero.
 * Nothing can be owed beyond the reserved maximum, so the exact charge is zero; any other case keeps money held.
 */
export function operatorTariffLocalSettlement(quote: ProviderSpendQuote, outcomeState: string): number | null {
  return quote.pricing.id === OPERATOR_TARIFF_PRICING_ID && quote.maxChargeMinorUnits === 0 && outcomeState === 'responded' ? 0 : null;
}
