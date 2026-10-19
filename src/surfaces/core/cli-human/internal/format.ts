import { t, type Locale } from '#platform/index.js';

/** Binary multiples after the plain byte count; symbols are language-neutral (the byte word itself is translated). */
const BYTE_UNITS = Object.freeze(['KB', 'MB', 'GB', 'TB', 'PB']);
const STEP = 1024, SECOND = 1000, MINUTE = 60, HOUR = 3600, DAY = 86_400;

/** A number without float noise in the locale's own separators (`0.49022299999999996` → `0,49` in Turkish). */
export function formatDecimal(value: number, locale: Locale, digits = 2): string {
  if (!Number.isFinite(value)) return t('cli.human.unknown', {}, locale);
  try { return new Intl.NumberFormat(t('cli.human.numberLocale', {}, locale), { maximumFractionDigits: Math.max(0, digits) }).format(value); }
  catch { return String(Number(value.toFixed(Math.max(0, digits)))); }
}

/** `583852032` → `557 MB`; three significant figures at most; below one kilobyte the translated byte word. */
export function formatBytes(bytes: number | null | undefined, locale: Locale): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return t('cli.human.unknown', {}, locale);
  if (bytes < STEP) return t('cli.human.bytes', { n: formatDecimal(bytes, locale, 0) }, locale);
  let value = bytes / STEP, unit = 0;
  while (value >= STEP && unit < BYTE_UNITS.length - 1) { value /= STEP; unit++; }
  return `${formatDecimal(value, locale, value >= 100 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

/** `490.2` → `0,49 sn`, `20900` → `20,9 sn`, then `3 dk 12 sn`, `2 sa 18 dk`, `3 g 4 sa`. */
export function formatDuration(ms: number | null | undefined, locale: Locale): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return t('cli.human.unknown', {}, locale);
  const seconds = ms / SECOND;
  if (seconds < MINUTE) return t('cli.human.seconds', { n: formatDecimal(seconds, locale, seconds < 10 ? 2 : 1) }, locale);
  const whole = Math.floor(seconds);
  if (whole < HOUR) return t('cli.human.minutes', { m: Math.floor(whole / MINUTE), s: whole % MINUTE }, locale);
  if (whole < DAY) return t('cli.human.hours', { h: Math.floor(whole / HOUR), m: Math.floor(whole % HOUR / MINUTE) }, locale);
  return t('cli.human.days', { d: Math.floor(whole / DAY), h: Math.floor(whole % DAY / HOUR) }, locale);
}

/** `12 sa önce`: the coarsest whole unit between `then` and `now` (host clock); a future instant reads as now. */
export function formatAgo(thenMs: number | null | undefined, nowMs: number, locale: Locale): string {
  if (thenMs === null || thenMs === undefined || !Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return t('cli.human.unknown', {}, locale);
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / SECOND));
  if (seconds < MINUTE) return t('cli.human.ago.now', {}, locale);
  if (seconds < HOUR) return t('cli.human.ago.minutes', { n: Math.floor(seconds / MINUTE) }, locale);
  if (seconds < DAY) return t('cli.human.ago.hours', { n: Math.floor(seconds / HOUR) }, locale);
  return t('cli.human.ago.days', { n: Math.floor(seconds / DAY) }, locale);
}

/** Epoch milliseconds as local wall time `2026-10-19 01:26` (the host's zone unless one is given); one unambiguous form in every language. */
export function formatClock(epochMs: number | null | undefined, locale: Locale, timeZone?: string): string {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) return t('cli.human.unknown', {}, locale);
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}) }).formatToParts(new Date(epochMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)?.value ?? '--';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/** Lists a person reads: items that wait for someone first, then newest to oldest; stable for equal keys. */
export function orderPendingFirst<T>(items: readonly T[], key: { readonly pending: (item: T) => boolean; readonly time: (item: T) => number | null | undefined }): T[] {
  const time = (item: T) => { const value = key.time(item); return value === null || value === undefined || !Number.isFinite(value) ? -Infinity : value; };
  return items.map((item, index) => ({ item, index })).sort((a, b) => Number(key.pending(b.item)) - Number(key.pending(a.item))
    || time(b.item) - time(a.item) || a.index - b.index).map(entry => entry.item);
}
