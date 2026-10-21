import { t, type Locale } from '#platform/index.js';
import type { ResourceView } from '#engine/index.js';
import { formatBytes, formatClock, formatDecimal, formatDuration } from '#surfaces/core/cli-human/index.js';
import UNITS from './units.json' with { type: 'json' };
const MS_PER_SECOND = UNITS.msPerSecond;
function resourceWords(locale: Locale) {
  return { states: { fresh: t('resource.state.fresh', {}, locale), stale: t('resource.state.stale', {}, locale), gap: t('resource.state.gap', {}, locale),
    unavailable: t('resource.state.unavailable', {}, locale), disabled: t('resource.state.disabled', {}, locale) },
  reasons: { starting: t('resource.reason.starting', {}, locale), unsupported: t('resource.reason.unsupported', {}, locale), denied: t('resource.reason.denied', {}, locale),
    timeout: t('resource.reason.timeout', {}, locale), identity: t('resource.reason.identity', {}, locale), invalid: t('resource.reason.invalid', {}, locale),
    overload: t('resource.reason.overload', {}, locale), 'store-unavailable': t('resource.reason.store-unavailable', {}, locale), 'queue-full': t('resource.reason.queue-full', {}, locale),
    disabled: t('resource.reason.disabled', {}, locale), missing: t('resource.reason.missing', {}, locale), 'counter-reset': t('resource.reason.counter-reset', {}, locale) } };
}
/** `· 2026-10-14 13:58 öncesi örnekler silindi`: the retention boundary as a local date, or nothing when none was applied. */
const trimmedText = (view: ResourceView, locale: Locale) => view.trimmedBeforeMs === null ? '' : t('resource.trimmed', { time: formatClock(view.trimmedBeforeMs, locale) }, locale);
/** PRE-5: units come from the shared formatter (`557 MB / 2 GB`, `4 g 0 sa`, `0,49 sn`); a view with no sample says so in one line instead of a row of unknowns. */
export function renderResourceLine(view: ResourceView | undefined, locale: Locale): string {
  if (!view) return t('resource.unavailable', {}, locale);
  const words = resourceWords(locale), latest = view.latest;
  if (!latest && view.sampleCount === 0) return t('resource.none', { reason: view.reason ? words.reasons[view.reason] : words.states[view.state], trimmed: trimmedText(view, locale) }, locale);
  return t('resource.worker', { cpu: latest?.cpuCores == null ? t('resource.unknown', {}, locale) : t('resource.cores', { n: formatDecimal(latest.cpuCores, locale) }, locale),
    memory: formatBytes(latest?.memoryBytes, locale), limit: formatBytes(latest?.memoryLimitBytes, locale), age: formatDuration(view.ageMs, locale), state: words.states[view.state] }, locale);
}
export function renderResourceDetail(view: ResourceView | undefined, locale: Locale): string[] {
  if (!view || (!view.latest && view.sampleCount === 0)) return [renderResourceLine(view, locale)];
  return [renderResourceLine(view, locale), t('resource.detail', { cpu: formatDuration(view.cpuSeconds === null ? null : view.cpuSeconds * MS_PER_SECOND, locale),
    peak: formatBytes(view.sampledPeakBytes, locale), kernel: formatBytes(view.latest?.kernelPeakBytes, locale),
    count: view.sampleCount, gaps: view.gapCount, reason: view.reason ? resourceWords(locale).reasons[view.reason] : t('resource.partial', {}, locale),
    trimmed: trimmedText(view, locale) }, locale)];
}
