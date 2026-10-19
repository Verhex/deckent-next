import { ErrorRegistry, MESSAGE_REGISTRY, redactForRecord, t, type Locale } from '#platform/index.js';
import { queueTerminal } from '#domain/index.js';
import type { TargetQueueView } from '#engine/index.js';
import { displayId, orderPendingFirst } from '#surfaces/core/cli-human/index.js';
/** Catalog lookup for the typed view's enum and adapter-owned keys (the same words as the terminal queue window). */
const word = (key: string, locale: Locale) => (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[key] ?? key;
const cell = (value: string) => redactForRecord(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
const width = (value: string) => [...value].length;
/**
 * Owner CLI review 2026-10-19 (C-PRIO): the human view of one queue page. Tickets still in flight come first, then the settled, parked,
 * cancelled or expired ones; inside each group the newest submission first (L-KIT `orderPendingFirst`; a view from an older service without
 * `submittedAt` keeps the page order). The ticket is the L-KIT short id, unique on this page; `--verbose` prints the full id (J1 lead decision).
 * A typed reason (why a ticket was parked or refused) stands on its own line under its row. `--json` never reaches this renderer.
 */
export function renderQueueList(page: { readonly records: readonly TargetQueueView[] }, scopeId: string, limit: number, locale: Locale,
  options: { readonly verbose?: boolean } = {}): string {
  if (!page.records.length) return t('queue.cli.list.empty', { scope: cell(scopeId) }, locale);
  const ids = page.records.map(view => view.commandId);
  const rows = orderPendingFirst(page.records, { pending: view => !queueTerminal(view.state), time: view => view.submittedAt })
    .map(view => ({ view, cells: [cell(view.identity.taskId), cell(view.target.id),
      word(view.outcome ? `queue.outcome.${view.outcome}` : `queue.state.${view.state}`, locale),
      word(view.nextAction === 'prepare-current' ? view.display.prepareActionKey : `queue.next.${view.nextAction}`, locale),
      cell(options.verbose ? view.commandId : displayId(view.commandId, ids))] }));
  const header = [t('queue.cli.list.column.task', {}, locale), t('queue.cli.list.column.target', {}, locale), t('queue.cli.list.column.state', {}, locale),
    t('queue.cli.list.column.next', {}, locale), t('queue.cli.list.column.ticket', {}, locale)];
  const sizes = header.map((title, column) => Math.max(width(title), ...rows.map(row => width(row.cells[column]!))));
  const line = (cells: readonly string[]) => cells.map((value, column) => column === cells.length - 1 ? value : value + ' '.repeat(sizes[column]! - width(value))).join('  ');
  const body = rows.flatMap(({ view, cells }) => [line(cells), ...(view.reason ? [t('queue.cli.list.reason', { reason: ErrorRegistry.createError(view.reason, { locale }).message }, locale)] : [])]);
  const last = page.records.at(-1)!.commandId;
  return [t('queue.cli.list.title', { scope: cell(scopeId), count: page.records.length }, locale), line(header), ...body,
    ...(page.records.length >= limit ? [t('queue.cli.list.more', { after: cell(last) }, locale)] : [])].join('\n');
}
