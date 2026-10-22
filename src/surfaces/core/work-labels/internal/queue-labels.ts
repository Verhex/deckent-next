import { t, type Locale } from '#platform/index.js';
import type { DeliveryWindowLabels } from '#surfaces/core/terminal-delivery/index.js';
import { renderQueueConsent, renderQueueStatus } from '#surfaces/core/effect-confirmation/index.js';
import { consentSummaryLines, renderDeliverySummary, ticketSummaryBlock } from '#surfaces/core/delivery-summary/index.js';
export function queueWindowLabels(locale: Locale): NonNullable<DeliveryWindowLabels['queue']> {
  return { reprepare: t('queue.window.reprepare', {}, locale), hints: t('queue.window.refresh', {}, locale), waiting: t('queue.window.waiting', {}, locale),
    card: view => renderQueueConsent(view, locale),
    status: view => renderQueueStatus(view, locale) };
}
/** TESLIM-KARTI-OZET words of the delivery window: `brief` leaves out the title, operation and files the window shows in its own rows. */
export function cardSummaryLabels(locale: Locale): NonNullable<DeliveryWindowLabels['cardSummary']> {
  return { lines: (summary, brief) => brief && summary ? renderDeliverySummary(summary, locale, { omit: ['title', 'operation', 'change'] }) : ticketSummaryBlock(summary, undefined, locale),
    consent: summaries => consentSummaryLines(summaries, locale) };
}
