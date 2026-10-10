import { t, type Locale } from '#platform/index.js';
import type { ModelInvocability } from '#engine/index.js';
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
    case 'budget': return state.reason.reservation ? t('tui.model.reason.reservation', { amount: (state.reason.reservation.requestedMinorUnits / 100)
      .toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US', { minimumFractionDigits: 2 }) }, locale) : t('model.invocable.budget', { code }, locale);
    case 'policy': return t('model.invocable.policy', { code }, locale);
    case 'protocol': return t('model.invocable.protocol', { code }, locale);
    case 'unavailable': return t('model.invocable.unavailable', { code }, locale);
  }
}
