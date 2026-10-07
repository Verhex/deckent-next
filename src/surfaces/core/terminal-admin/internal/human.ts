import type { Locale } from '#platform/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The short form of an identity on a primary line: the first 8 characters of a UUID (the form `/resume` shows); anything else is already human-sized. */
export function shortId(value: string): string { return UUID.test(value) ? value.slice(0, 8) : value; }

/** A whole count with the locale's thousands separator (38,643 / 38.643). */
export function count(value: number | string | bigint, locale: Locale): string {
  try { return new Intl.NumberFormat(locale).format(typeof value === 'string' ? BigInt(value) : value); }
  catch { return String(value); }
}
