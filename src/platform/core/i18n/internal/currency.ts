import type { Locale } from './types.js';
/** Currency-defined minor-unit precision; decimal-only mode preserves existing reservation wording. */
export function currencyAmountText(minorUnits: number, currency: string, locale: Locale, symbol = true): string {
  const tag = locale === 'tr' ? 'tr-TR' : 'en-US';
  const currencyFormatter = new Intl.NumberFormat(tag, { style: 'currency', currency });
  const digits = currencyFormatter.resolvedOptions().maximumFractionDigits!;
  const minor = BigInt(minorUnits), absolute = minor < 0n ? -minor : minor, scale = 10n ** BigInt(digits);
  // ECMA-402 accepts an exact decimal string; avoid losing a cent when a safe integer approaches the number limit.
  const amount = `${minor < 0n ? '-' : ''}${absolute / scale}${digits ? '.' + (absolute % scale).toString().padStart(digits, '0') : ''}`;
  const formatter = symbol ? currencyFormatter : new Intl.NumberFormat(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  // TypeScript's Intl declarations still restrict these inputs to number|bigint.
  const format = formatter.format as (value: string | number | bigint) => string;
  if (!symbol || locale !== 'tr') return format(amount);
  // The Turkish money contract puts the currency symbol after the localized amount.
  const parts = (formatter.formatToParts as (value: string | number | bigint) => Intl.NumberFormatPart[])(amount);
  return `${parts.filter(part => part.type !== 'currency' && part.type !== 'literal').map(part => part.value).join('')} ${parts.find(part => part.type === 'currency')!.value}`;
}
