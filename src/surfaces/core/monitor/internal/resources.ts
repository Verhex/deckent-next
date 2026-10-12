import { t, type Locale } from '#platform/index.js';
import type { ResourceView } from '#engine/index.js';
function resourceWords(locale: Locale) {
  return { states: { fresh: t('resource.state.fresh', {}, locale), stale: t('resource.state.stale', {}, locale), gap: t('resource.state.gap', {}, locale),
    unavailable: t('resource.state.unavailable', {}, locale), disabled: t('resource.state.disabled', {}, locale) },
  reasons: { starting: t('resource.reason.starting', {}, locale), unsupported: t('resource.reason.unsupported', {}, locale), denied: t('resource.reason.denied', {}, locale),
    timeout: t('resource.reason.timeout', {}, locale), identity: t('resource.reason.identity', {}, locale), invalid: t('resource.reason.invalid', {}, locale),
    overload: t('resource.reason.overload', {}, locale), 'store-unavailable': t('resource.reason.store-unavailable', {}, locale), 'queue-full': t('resource.reason.queue-full', {}, locale),
    disabled: t('resource.reason.disabled', {}, locale), missing: t('resource.reason.missing', {}, locale), 'counter-reset': t('resource.reason.counter-reset', {}, locale) } };
}
export function renderResourceLine(view: ResourceView | undefined, locale: Locale): string {
  if (!view) return t('resource.unavailable', {}, locale);
  const n = (value: number | null | undefined) => value == null ? t('resource.unknown', {}, locale) : String(Math.round(value * 100) / 100);
  return t('resource.worker', { cpu: n(view.latest?.cpuCores), memory: n(view.latest?.memoryBytes), limit: n(view.latest?.memoryLimitBytes),
    age: n(view.ageMs), state: resourceWords(locale).states[view.state] }, locale);
}
export function renderResourceDetail(view: ResourceView | undefined, locale: Locale): string[] {
  return [renderResourceLine(view, locale), ...(view ? [t('resource.detail', { cpu: view.cpuSeconds ?? t('resource.unknown', {}, locale),
    peak: view.sampledPeakBytes ?? t('resource.unknown', {}, locale), kernel: view.latest?.kernelPeakBytes ?? t('resource.unknown', {}, locale),
    count: view.sampleCount, gaps: view.gapCount, reason: view.reason ? resourceWords(locale).reasons[view.reason] : t('resource.partial', {}, locale),
    trimmed: view.trimmedBeforeMs ?? t('resource.unknown', {}, locale) }, locale)] : [])];
}
