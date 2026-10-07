import type { Locale } from '#platform/index.js';

/** A whole count with the locale's thousands separator (38,643 / 38.643). */
export function count(value: number | string | bigint, locale: Locale): string {
  try { return new Intl.NumberFormat(locale).format(typeof value === 'string' ? BigInt(value) : value); }
  catch { return String(value); }
}
