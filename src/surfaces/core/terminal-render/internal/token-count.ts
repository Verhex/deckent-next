import UNITS from './token-units.json' with { type: 'json' };
/** Display only: preserve full counts for admission and percentages. Compact unit suffixes are language-neutral. */
export function formatContextTokens(tokens: number, locale: 'en' | 'tr' = 'en'): string {
  const formatter = new Intl.NumberFormat(locale === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: UNITS.fractionDigits });
  for (const unit of [UNITS.million, UNITS.thousand]) if (tokens >= unit.threshold) return `${formatter.format(tokens / unit.divisor)} ${unit.suffix}`;
  return formatter.format(tokens);
}
