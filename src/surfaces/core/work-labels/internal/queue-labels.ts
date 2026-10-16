import { t, type Locale } from '#platform/index.js';
import type { DeliveryWindowLabels } from '#surfaces/core/terminal-delivery/index.js';
import { renderQueueConsent, renderQueueStatus } from '#surfaces/core/effect-confirmation/index.js';
export function queueWindowLabels(locale: Locale): NonNullable<DeliveryWindowLabels['queue']> {
  return { reprepare: t('queue.window.reprepare', {}, locale), hints: t('queue.window.refresh', {}, locale), waiting: t('queue.window.waiting', {}, locale),
    card: view => renderQueueConsent(view, locale),
    status: view => renderQueueStatus(view, locale) };
}
