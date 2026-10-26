import { t, type Locale } from '#platform/index.js';
import type { WorkerImageState } from '#engine/index.js';
import { formatDecimal, formatDuration } from '#surfaces/core/cli-human/index.js';

/** S4: source-bound selection shared by onboarding and /setup. Owner 2026-10-26 (Enter accepts the recommended answer): a ready image of this
 * installation is highlighted, else the background build of the shown sources; nothing runs until the person presses Enter. */
export function workerImageQuestion(preview: Readonly<{ providers: readonly string[]; sources: readonly string[]; proxy: string | null;
  baseRef: string; sizeGigabytes: number | null; referenceMs?: number | null; buildTimeoutMs: number; previousMs?: number | null; images?: readonly Readonly<{ imageId: string; tag: string; ready: boolean }>[] }>,
  locale: Locale, repair?: string) {
  const images = [...preview.images ?? []].sort((a, b) => Number(b.ready) - Number(a.ready));
  return { title: t('setup.workerImage.card.providers', { providers: preview.providers.join(', ') }, locale), initial: images.find(image => image.ready)?.imageId ?? 'consent',
    body: [t('setup.workerImage.card.downloads', { size: preview.sizeGigabytes == null ? '-' : formatDecimal(preview.sizeGigabytes, locale, 1), limit: formatDuration(preview.buildTimeoutMs, locale) }, locale),
      // This machine's own previous build wins; otherwise the measured first build of this recipe on the reference machine, never the timeout.
      ...(preview.previousMs != null ? [t('setup.workerImage.progress.previous', { elapsed: formatDuration(preview.previousMs, locale) }, locale)]
        : preview.referenceMs != null ? [t('setup.workerImage.card.reference', { elapsed: formatDuration(preview.referenceMs, locale) }, locale)] : [t('setup.workerImage.progress.unmeasured', {}, locale)]),
      ...preview.sources, preview.baseRef, t('setup.workerImage.card.proxy', { proxy: preview.proxy ?? '-' }, locale),
      ...(repair ? [t('setup.workerImage.card.repair', { image: repair }, locale)] : []),
      t('setup.workerImage.card.foreground', {}, locale), t('setup.workerImage.card.next', {}, locale)],
    choices: [...images.map(image => ({ id: image.imageId, disabled: !image.ready,
      label: image.ready ? t('setup.workerImage.card.useExisting', { tag: image.tag, image: image.imageId }, locale) : t('setup.workerImage.card.lineageUnknown', { tag: image.tag, image: image.imageId }, locale) })),
      { id: 'consent', label: t('setup.workerImage.card.buildInBackground', {}, locale) }, { id: 'later', label: t('setup.workerImage.card.later', {}, locale) }] };
}
/** No invented ETA: phase, elapsed time and the last durable update are the observable progress. */
export function workerImageProgress(state: WorkerImageState, locale: Locale, now = Date.now()): readonly string[] {
  const phase = { requested: t('setup.workerImage.requested', {}, locale), 'waiting-docker': t('setup.workerImage.waiting-docker', {}, locale),
    acquiring: t('setup.workerImage.acquiring', {}, locale), ready: t('setup.workerImage.ready', {}, locale),
    failed: t('setup.workerImage.failed', {}, locale), declined: t('setup.workerImage.declined', {}, locale) }[state.phase];
  const step = state.step?.startsWith('layer:') ? t('setup.workerImage.progress.layer', { provider: state.step.slice(6) }, locale)
    : state.step === 'base' ? t('setup.workerImage.progress.base', {}, locale) : state.step === 'probe' ? t('setup.workerImage.progress.probe', {}, locale) : '';
  return [phase, step, t('setup.workerImage.progress.elapsed', { elapsed: formatDuration(Math.max(0, now - Date.parse(state.startedAt)), locale), at: state.lastProgressAt }, locale),
    ...(state.code ? [state.code] : [])].filter(Boolean);
}
