import { t, type Locale } from '#platform/index.js';
import type { ModelInvocability } from './invocable-now.js';

export function reservationAmountText(minorUnits: number, currency: string, locale: Locale): string {
  const tag = locale === 'tr' ? 'tr-TR' : 'en-US';
  const digits = new Intl.NumberFormat(tag, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits!;
  return (minorUnits / 10 ** digits).toLocaleString(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Shared words for every model-state surface. No readiness decisions live in renderers. */
export function modelInvocabilityText(state: ModelInvocability, locale: Locale): string {
  if (state.invocable) return t('model.invocable.ready', {}, locale);
  const { kind, code } = state.reason;
  switch (kind) {
    case 'stale-activation': return t('model.invocable.stale', {}, locale);
    case 'not-carried': return t('model.invocable.notCarried', {}, locale);
    case 'binding': return t('model.invocable.binding', {}, locale);
    case 'profile': return t('model.invocable.profile', {}, locale);
    case 'delivery-unfit': return t('model.invocable.delivery', {}, locale);
    case 'no-credential': return t('model.invocable.credential', {}, locale);
    case 'tariff': return t('model.invocable.tariff', { code }, locale);
    // PROVIDER-ERRORS N01: the refused call's own reservation leads; the typed code and the reconcile/budget next step always stay.
    case 'budget': return `${state.reason.reservation ? `${t('tui.model.reason.reservation', { amount: reservationAmountText(state.reason.reservation.requestedMinorUnits, state.reason.reservation.currency, locale), currency: state.reason.reservation.currency }, locale)} ` : ''}${t('model.invocable.budget', { code }, locale)}`;
    case 'policy': return t('model.invocable.policy', { code }, locale);
    case 'protocol': return t('model.invocable.protocol', { code }, locale);
    case 'unavailable': return `${t('model.invocable.unavailable', { code }, locale)} ${t('model.invocable.unavailableNext', {}, locale)}`;
  }
}
