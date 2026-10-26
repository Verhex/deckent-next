import { t, type Locale } from '#platform/index.js';
import type { ProviderSpendAccountInspection } from '#engine/index.js';

/** The installation's period, not the observer machine's time zone. The canonical checkpoint remains immutable. */
export function spendPeriodLines(result: ProviderSpendAccountInspection, locale: Locale): string[] {
  const state = result.period?.state ?? result.checkpoint?.account.period;
  if (!state) return result.checkpoint ? [t('models.spending.period.pending', {}, locale)] : [];
  const zone = result.period?.localTimeZone ?? state.timeZone;
  const date = new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-US', { timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(state.nextResetAtMs);
  return [state.calendarMonths === 1 ? t('models.spending.period.monthly', { date, zone }, locale)
    : t('models.spending.period.calendar', { date, zone, months: state.calendarMonths }, locale),
    ...(state.legacyTransition ? [t('models.spending.period.legacy', {}, locale)] : [])];
}
