import { ceilUsdCents, decimalRate, decimalText } from './decimal.js';

/** Native reported account charge, not a tariff-derived calculation or an invoice.
 * The caller must obtain the numeric token from the accepted native response, not Number.toString().
 * Ceil once at Deckent's minor-unit boundary; retain the exact decimal for later reconciliation.
 */
export function parseOpenRouterReportedCharge(numericSource: string) {
  const rate = decimalRate(numericSource);
  return Object.freeze({ exactChargeUsd: decimalText(rate), roundedChargeMinorUnits: ceilUsdCents(rate) });
}
