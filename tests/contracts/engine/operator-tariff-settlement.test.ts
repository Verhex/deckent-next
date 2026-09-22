import { expect, it } from 'vitest';
import { OPERATOR_TARIFF_PRICING_ID, operatorTariffLocalSettlement } from '#engine/index.js';
import type { ProviderSpendQuote } from '#domain/index.js';

const quote = (id: string, maxChargeMinorUnits: number) => ({ pricing: { id }, maxChargeMinorUnits }) as unknown as ProviderSpendQuote;

it('settles at zero only for a responded operator tariff with a zero verified bound; every other case keeps money held', () => {
  expect(operatorTariffLocalSettlement(quote(OPERATOR_TARIFF_PRICING_ID, 0), 'responded')).toBe(0);
  for (const state of ['unknown', 'rejected', 'not-sent']) expect(operatorTariffLocalSettlement(quote(OPERATOR_TARIFF_PRICING_ID, 0), state)).toBeNull();
  expect(operatorTariffLocalSettlement(quote(OPERATOR_TARIFF_PRICING_ID, 1), 'responded')).toBeNull();
  expect(operatorTariffLocalSettlement(quote('openrouter-endpoint-tariff', 0), 'responded')).toBeNull();
});
