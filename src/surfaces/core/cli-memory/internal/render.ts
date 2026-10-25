import { t, type Locale } from '#platform/index.js';
import { isMemoryTombstone, type MemoryContent, type MemoryEntry, type MemoryState } from '#domain/index.js';
import { cliTableStyle, displayId, formatAgo, formatUsd, renderCliTable, safeCell } from '#surfaces/core/cli-human/index.js';
import type { MemoryCommandContext } from './context.js';

export const state = (value: MemoryState, locale: Locale) => value === 'candidate' ? t('memory.state.candidate', {}, locale) : value === 'verified' ? t('memory.state.verified', {}, locale)
  : t('memory.state.retired', {}, locale);
const kind = (entry: MemoryEntry, locale: Locale) => isMemoryTombstone(entry.content) ? '-' : entry.content.kind === 'lesson' ? t('memory.kind.lesson', {}, locale)
  : t('memory.kind.fact', {}, locale);
/** S4B-4: a purged entry shows its tombstone line in place of a title; no content is left to show. */
export const reason = (code: string, locale: Locale) => code === 'personal-data' ? t('memory.purge.reason.personal-data', {}, locale)
  : code === 'poisoned' ? t('memory.purge.reason.poisoned', {}, locale) : code === 'expired' ? t('memory.purge.reason.expired', {}, locale) : t('memory.purge.reason.other', {}, locale);
const tombstoneLine = (entry: MemoryEntry, locale: Locale) => isMemoryTombstone(entry.content) ? t('memory.view.tombstone', { reason: reason(entry.content.reasonCode, locale) }, locale) : '';
export const titleOf = (entry: MemoryEntry, locale: Locale) => isMemoryTombstone(entry.content) ? tombstoneLine(entry, locale) : safeCell(entry.content.title);
const actor = (who: { issuer: string; subject: string }) => safeCell(`${who.issuer}:${who.subject}`);
export function table(entries: readonly MemoryEntry[], locale: Locale, context: MemoryCommandContext): string {
  const ids = entries.map(entry => entry.entryId), now = Date.now();
  return renderCliTable([{ header: t('memory.column.id', {}, locale) }, { header: t('memory.column.state', {}, locale) }, { header: t('memory.column.kind', {}, locale) },
    { header: t('memory.column.title', {}, locale), shrink: true }, { header: t('memory.column.changed', {}, locale) }],
  entries.map(entry => [displayId(entry.entryId, ids), state(entry.state, locale), kind(entry, locale), isMemoryTombstone(entry.content) ? tombstoneLine(entry, locale) : entry.content.title,
    formatAgo(entry.updatedAtMs, now, locale)]), cliTableStyle(context));
}
/** One entry for a person: content, lesson fields, who proposed it from where, how it was verified or retired, then every revision. */
export function contentLines(content: MemoryContent, locale: Locale): string[] {
  const lesson = content.lesson;
  return [safeCell(content.body), ...(content.tags.length ? [t('memory.view.tags', { tags: content.tags.map(tag => safeCell(tag)).join(', ') }, locale)] : []),
    ...(lesson ? [t('memory.view.lesson', { source: safeCell(lesson.source), cause: safeCell(lesson.cause), correction: safeCell(lesson.correction), evidence: safeCell(lesson.evidence) }, locale)] : [])];
}
export function view(entry: MemoryEntry, history: readonly MemoryEntry[], locale: Locale): string {
  const now = Date.now(), { content, provenance, verification, retirement } = entry;
  return [titleOf(entry, locale), t('memory.view.state', { kind: kind(entry, locale), state: state(entry.state, locale), revision: entry.revision, changed: formatAgo(entry.updatedAtMs, now, locale) }, locale),
    ...(isMemoryTombstone(content) ? [] : contentLines(content, locale)),
    t('memory.view.author', { author: actor(provenance.author), who: provenance.author.ai ? t('memory.view.author.ai', {}, locale) : t('memory.view.author.person', {}, locale),
      origin: safeCell(provenance.origin.ref ? `${provenance.origin.kind} ${provenance.origin.ref}` : provenance.origin.kind) }, locale),
    verification?.basis === 'human-review' ? t('memory.view.verified.human-review', { reviewer: actor(verification.reviewer), note: safeCell(verification.note) }, locale)
      : verification ? t('memory.view.verified.independent-evaluation', { record: safeCell(`${verification.record.kind}/${verification.record.id}`), evaluator: actor(verification.evaluator) }, locale)
        : entry.state === 'candidate' ? t('memory.view.unverified', {}, locale) : '',
    ...(retirement ? [t('memory.view.retired', { by: actor(retirement.by), reason: safeCell(retirement.reason) }, locale),
      ...(retirement.supersededBy ? [t('memory.view.superseded', { id: safeCell(retirement.supersededBy) }, locale)] : [])] : []),
    t('memory.view.history', {}, locale), ...history.map(item => t('memory.view.revision', { revision: item.revision, state: state(item.state, locale), at: formatAgo(item.updatedAtMs, now, locale) }, locale)),
  ].filter(Boolean).join('\n');
}

/**
 * `deckent memory [search <words…> | inspect <id>]` (S4 v1, read-only). A read the journal could not complete is shown as held on stderr with
 * the next step and exits 1 (`--json` prints the held result); it is never shown as an empty memory.
 */
/** S4B-3: one line per evaluator row (or that none is available), read-only; prices are catalog data, the caps are the registry's. */
export function evaluatorLines(view: Awaited<ReturnType<NonNullable<MemoryCommandContext['inspectMemoryEvaluators']>>>, locale: Locale): string[] {
  if (!view.available) return [t('memory.view.noIndependentEvaluator', {}, locale)];
  const price = (row: typeof view.rows[number]) => row.price.kind === 'subscription' ? t('memory.view.evaluator.price.subscription', {}, locale)
    : row.price.kind === 'per-token' ? t('memory.view.evaluator.price.perToken', { input: formatUsd(Number(row.price.inputPerMTok), locale), output: formatUsd(Number(row.price.outputPerMTok), locale), asOf: safeCell(row.price.asOf),
      ceiling: formatUsd(Number(row.price.answersPerDayCeiling), locale), calls: view.callsPerDay, tokens: view.maxCompletionTokens }, locale) : t('memory.view.evaluator.price.notVerified', {}, locale);
  const groups = new Map<string, { models: string[]; row: typeof view.rows[number] }>();
  for (const row of view.rows.filter(row => row.invocable && row.maker !== null)) {
    const key = JSON.stringify([row.maker, row.price]), group = groups.get(key) ?? { models: [], row };
    group.models.push(safeCell(`${row.channelId}/${row.modelId}`)); groups.set(key, group);
  }
  return [...groups.values()].map(group => t('memory.view.evaluator', { model: group.models.join(', '),
    maker: safeCell(group.row.maker!), price: price(group.row) }, locale)).concat(t('memory.view.evaluator.independence', {}, locale));
}
