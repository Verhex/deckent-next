import { ErrorRegistry, MESSAGE_REGISTRY, redactForRecord, t, type Locale } from '#platform/index.js';
import { queueTerminal } from '#domain/index.js';
import type { DeliverySummary, TargetQueueView } from '#engine/index.js';
import { summaryListCells, type AutonomyShadowView } from '#surfaces/core/delivery-summary/index.js';
import { displayId } from '#surfaces/core/cli-human/index.js';
/** Catalog lookup for the typed view's enum and adapter-owned keys (the same words as the terminal queue window). */
const word = (key: string, locale: Locale) => (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[key] ?? key;
const cell = (value: string) => redactForRecord(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
const width = (value: string) => [...value].length;
/**
 * Owner CLI review 2026-10-19 (C-PRIO): the human view of one queue page. Tickets still in flight come first, then the settled, parked,
 * cancelled or expired ones; inside each group the service's page order stays (the protocol v29 view carries no submission time: Astra 2661
 * R2 deferred `submittedAt` to a protocol bump, and no v29 field is monotonic with submission). The ticket is the L-KIT short id, unique on
 * this page; `--verbose` prints the full id (J1 lead decision).
 * A typed reason (why a ticket was parked or refused) stands on its own line under its row. `--json` never reaches this renderer.
 */
export function renderQueueList(page: { readonly records: readonly TargetQueueView[] }, scopeId: string, limit: number, locale: Locale,
  options: { readonly verbose?: boolean; readonly summaries?: readonly (DeliverySummary | null)[]; readonly shadows?: readonly (AutonomyShadowView | null)[] } = {}): string {
  if (!page.records.length) return t('queue.cli.list.empty', { scope: cell(scopeId) }, locale);
  const ids = page.records.map(view => view.commandId);
  // TESLIM-KARTI-OZET: with summaries read, a title and a one-word risk column; with shadow records, the rule-off column (never a decision).
  const extra = (index: number) => {
    const cells = summaryListCells(options.summaries?.[index], options.shadows?.[index], locale);
    return { lead: options.summaries ? [cell(cells.title)] : [], tail: [...options.summaries ? [cells.risk] : [], ...options.shadows ? [cells.shadow] : []] };
  };
  const rows = [...page.records.entries()].sort(([, a], [, b]) => Number(queueTerminal(a.state)) - Number(queueTerminal(b.state)))
    .map(([index, view]) => { const more = extra(index); return { view, cells: [cell(view.identity.taskId), ...more.lead, cell(view.target.id),
      word(view.outcome ? `queue.outcome.${view.outcome}` : `queue.state.${view.state}`, locale),
      word(view.nextAction === 'prepare-current' ? view.display.prepareActionKey : `queue.next.${view.nextAction}`, locale),
      ...more.tail, cell(options.verbose ? view.commandId : displayId(view.commandId, ids))] }; });
  const header = [t('queue.cli.list.column.task', {}, locale), ...options.summaries ? [t('delivery.list.column.title', {}, locale)] : [],
    t('queue.cli.list.column.target', {}, locale), t('queue.cli.list.column.state', {}, locale), t('queue.cli.list.column.next', {}, locale),
    ...options.summaries ? [t('delivery.list.column.risk', {}, locale)] : [], ...options.shadows ? [t('delivery.list.column.shadow', {}, locale)] : [],
    t('queue.cli.list.column.ticket', {}, locale)];
  const sizes = header.map((title, column) => Math.max(width(title), ...rows.map(row => width(row.cells[column]!))));
  const line = (cells: readonly string[]) => cells.map((value, column) => column === cells.length - 1 ? value : value + ' '.repeat(sizes[column]! - width(value))).join('  ');
  const body = rows.flatMap(({ view, cells }) => [line(cells), ...(view.reason ? [t('queue.cli.list.reason', { reason: ErrorRegistry.createError(view.reason, { locale }).message }, locale)] : [])]);
  const last = page.records.at(-1)!.commandId;
  return [t('queue.cli.list.title', { scope: cell(scopeId), count: page.records.length }, locale), line(header), ...body,
    ...(page.records.length >= limit ? [t('queue.cli.list.more', { after: cell(last) }, locale)] : [])].join('\n');
}
