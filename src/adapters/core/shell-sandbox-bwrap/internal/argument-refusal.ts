import { resolveLocale, t } from '#platform/index.js';
import { BUBBLEWRAP_ARGUMENT_MAX_COUNT } from './arguments.js';

export const SANDBOX_VIEW_TOO_LARGE = 'SANDBOX_VIEW_TOO_LARGE';

export function argumentCountRefusal(count: number, counts: Readonly<{ home: number; protective: number; pins: number; remounts: number; tail: number }>,
  environment: Readonly<Record<string, string | undefined>>, isolated = false): string {
  const other = count - counts.home - counts.protective - counts.pins - counts.remounts - counts.tail;
  const locale = resolveLocale(undefined, environment);
  const reason = t('shell.sandboxArgumentCountExceeded', { count, bound: BUBBLEWRAP_ARGUMENT_MAX_COUNT, ...counts, other }, locale);
  const remedy = isolated ? t('shell.sandboxIsolatedArgumentCountRemedy', undefined, locale) : t('shell.sandboxArgumentCountRemedy', undefined, locale);
  return `${reason} ${remedy}`;
}
