import { expect, it } from 'vitest';
import { modelInvocabilityText, reservationAmountText } from '#engine/index.js';
import { t } from '#platform/index.js';

it.each([
  ['USD', 'en', '1,234.56 USD'],
  ['USD', 'tr', '1.234,56 USD'],
  ['JPY', 'en', '123,456 JPY'],
  ['JPY', 'tr', '123.456 JPY'],
  ['KWD', 'en', '123.456 KWD'],
  ['KWD', 'tr', '123,456 KWD'],
  ['XYZ', 'en', '1,234.56 XYZ'],
  ['XYZ', 'tr', '1.234,56 XYZ'],
] as const)('renders %s reservation minor units in %s as %s', (currency, locale, amount) => {
  const text = modelInvocabilityText({ invocable: false, reason: {
    kind: 'budget', code: 'PROVIDER_SPEND_EXHAUSTED', reservation: { requestedMinorUnits: 123456, currency },
  } }, locale);
  expect(text).toContain(amount);
  expect(text.endsWith(t('model.invocable.budget', { code: 'PROVIDER_SPEND_EXHAUSTED' }, locale))).toBe(true);
});

it.each(['en', 'tr'] as const)('renders zero JPY without fractional digits in %s', locale => {
  expect(reservationAmountText(0, 'JPY', locale)).toBe('0');
});

it.each([
  ['en', '0.05'],
  ['tr', '0,05'],
] as const)('renders five USD minor units in %s as %s', (locale, amount) => {
  expect(reservationAmountText(5, 'USD', locale)).toBe(amount);
});
