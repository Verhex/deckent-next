import { ErrorRegistry, MESSAGE_REGISTRY, redactForRecord, t, type Locale } from '#platform/index.js';
import type { DeliverySummary, TargetBatchExecution, TargetQueueView } from '#engine/index.js';
import { ticketSummaryBlock, type AutonomyShadowView } from '#surfaces/core/delivery-summary/index.js';
/** Catalog lookup for the typed view's enum and adapter-owned keys (the same words as the list table and the terminal queue window). */
const word = (key: string, locale: Locale) => (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[key] ?? key;
const cell = (value: string) => redactForRecord(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
/** TESLIM-KARTI-OZET: a ticket's summary (undefined = not read) and, on inspect only, the rule-off shadow line. */
export type TicketExtras = Readonly<{ summary?: DeliverySummary | null; shadow?: AutonomyShadowView | null }>;
const verificationWord = (phase: NonNullable<TargetQueueView['verification']>['phase'], locale: Locale) => ({ accepted: () => t('queue.cli.ticket.verification.accepted', {}, locale),
  failed: () => t('queue.cli.ticket.verification.failed', {}, locale), pending: () => t('queue.cli.ticket.verification.pending', {}, locale),
  cancelled: () => t('queue.cli.ticket.verification.cancelled', {}, locale), unknown: () => t('queue.cli.ticket.verification.unknown', {}, locale) })[phase]();
/** One batch line per ticket: its settlement, whether its publication happened and the typed reason a refusal or an unknown outcome carries. */
const itemLine = (item: TargetBatchExecution['items'][number], locale: Locale) => {
  const params = { ticket: cell(item.commandId), published: item.published ? t('queue.cli.confirm.published.yes', {}, locale) : t('queue.cli.confirm.published.no', {}, locale),
    reason: item.reason ? ErrorRegistry.createError(item.reason, { locale }).message : '' };
  return item.state === 'settled' ? t('queue.cli.confirm.item.settled', params, locale) : item.state === 'refused' ? t('queue.cli.confirm.item.refused', params, locale)
    : t('queue.cli.confirm.item.unknown', params, locale);
};
/**
 * The human view of one queue ticket (inspect, enqueue and rollback results): who and what, where it stands, why it stopped and what
 * comes next. Ids are printed whole (a person copies them into the next command); `--json` never reaches this renderer.
 */
export function renderQueueTicket(view: TargetQueueView, scopeId: string, locale: Locale, extras: TicketExtras = {}): string {
  const state = word(view.outcome ? `queue.outcome.${view.outcome}` : `queue.state.${view.state}`, locale);
  const next = word(view.nextAction === 'prepare-current' ? view.display.prepareActionKey : `queue.next.${view.nextAction}`, locale);
  const lines = [t('queue.cli.ticket.title', { ticket: cell(view.commandId), task: cell(view.identity.taskId), operation: (view.operation === 'delivery' ? t('queue.cli.ticket.operation.delivery', {}, locale) : t('queue.cli.ticket.operation.rollback', {}, locale)) }, locale),
    ...ticketSummaryBlock(extras.summary, extras.shadow, locale, view.state === 'settled'),
    t('queue.cli.ticket.target', { label: word(view.display.labelKey, locale), target: cell(view.target.id) }, locale),
    t('queue.cli.ticket.state', { state }, locale),
    ...(view.position !== null ? [t('queue.cli.ticket.position', { position: view.position }, locale)] : []),
    ...(view.verification ? [t('queue.cli.ticket.verification', { phase: verificationWord(view.verification.phase, locale) }, locale)] : []),
    ...(view.reason ? [t('queue.cli.list.reason', { reason: ErrorRegistry.createError(view.reason, { locale }).message }, locale).trimStart()] : []),
    t('queue.cli.ticket.next', { next }, locale)];
  if (view.nextAction === 'confirm-batch') lines.push(t('queue.cli.ticket.confirmHint', { scope: cell(scopeId), ticket: cell(view.commandId) }, locale));
  return lines.join('\n');
}
/** The result of `integration-queue-confirm`: the settled prefix and one line per ticket of the batch, with its typed reason when it stopped. */
export function renderQueueExecution(execution: TargetBatchExecution, locale: Locale): string {
  if (!execution.items.length) return t('queue.cli.confirm.none', {}, locale);
  return [t('queue.cli.confirm.title', { settled: execution.settledPrefix, total: execution.items.length }, locale),
    ...execution.items.map(item => itemLine(item, locale))].join('\n');
}
