import { randomUUID } from 'node:crypto';
import { ErrorRegistry, EXIT_CODES, emit, t, type ExitCode, type Locale } from '#platform/index.js';
import { MEMORY_LIMITS, MEMORY_PURGE_REASONS, isMemoryTombstone, type MemoryContest, type MemoryEntry, type MemoryEvaluationRecord } from '#domain/index.js';
import type { MemoryReviewItem, MemorySourceEntries } from '#engine/index.js';
import { safeCell, scopeNotice, type CliCardOption } from '#surfaces/core/cli-human/index.js';
import { sinksOf } from '#surfaces/core/cli-approval/index.js';
import type { MemoryCommandContext } from './context.js';
import type { Parsed } from './command.js';
import { cardOptions, type WriteContext } from './write.js';
import { contentLines, reason, state, titleOf } from './render.js';

const DAY_MS = 86_400_000;
const option = (id: string, label: string, key: string): CliCardOption => ({ id, label, key });
const actor = (who: { issuer: string; subject: string }) => safeCell(`${who.issuer}:${who.subject}`);
const sourceText = (source: NonNullable<Parsed['source']>) => safeCell(source.attemptId ? `${source.runId}/${source.attemptId}` : source.runId);
function evaluationLine(record: MemoryEvaluationRecord, locale: Locale) {
  const verdict = record.verdict === 'pass' ? t('memory.view.evaluation.verdict.pass', {}, locale) : record.verdict === 'fail' ? t('memory.view.evaluation.verdict.fail', {}, locale)
    : t('memory.view.evaluation.verdict.unknown', {}, locale);
  return t('memory.view.evaluation', { mode: record.mode === 'live' ? t('memory.view.evaluation.mode.live', {}, locale) : t('memory.view.evaluation.mode.shadow', {}, locale), verdict,
    model: safeCell(`${record.evaluatorModel.channelId}/${record.evaluatorModel.modelId}`), maker: safeCell(record.evaluatorModel.maker ?? '-'),
    reasons: record.reasonCodes.length ? record.reasonCodes.map(code => safeCell(code)).join(', ') : t('memory.view.evaluation.reasons.none', {}, locale) }, locale);
}
/** One review item: content, audience, evidence (support rows), every sealed evaluator record (shadow ones too) and the stale/contested marks. */
function entryLines(entry: MemoryEntry, locale: Locale): string[] {
  const audience = entry.audience;
  return [titleOf(entry, locale), `${state(entry.state, locale)} · ${safeCell(entry.entryId)} · ${actor(entry.provenance.author)}`,
    ...(isMemoryTombstone(entry.content) ? [] : contentLines(entry.content, locale)),
    audience ? t('memory.view.audience', { family: safeCell(audience.workClassFamily), target: audience.workTargetId ? safeCell(audience.workTargetId) : t('memory.view.audience.anyTarget', {}, locale) }, locale)
      : t('memory.view.audience.scopeWide', {}, locale)];
}
export function reviewLines(item: MemoryReviewItem, locale: Locale): string[] {
  return [...entryLines(item.entry, locale),
    ...(item.support.length ? item.support.map(row => t('memory.view.support', { run: safeCell(row.source.runId), task: safeCell(row.source.taskId), attempt: safeCell(row.source.attemptId),
      rule: safeCell(row.ruleId), version: row.ruleVersion, evaluation: safeCell(row.evaluationId),
      producer: row.producer === 'rule' ? t('memory.view.support.producer.rule', {}, locale) : t('memory.view.support.producer.worker-claim', {}, locale) }, locale))
      : [t('memory.view.support.none', {}, locale)]),
    ...(item.evaluations.length ? item.evaluations.map(record => evaluationLine(record, locale)) : [t('memory.view.evaluation.none', {}, locale)]),
    ...(item.stale && item.retentionMs !== null ? [t('memory.view.stale', { days: Math.round(item.retentionMs / DAY_MS) }, locale)] : []),
    ...(item.contests.length ? [t('memory.view.contested', {}, locale)] : [])];
}
const reasonOptions = (locale: Locale) => [...MEMORY_PURGE_REASONS.map((code, index) => option(code, reason(code, locale), String(index + 1))),
  option('cancel', t('memory.card.cancel', {}, locale), 'n')];
type Counts = { verified: number; retired: number; purged: number; resolved: number; skipped: number };
/** The purge card for one or more entries (honest scope text), then each purge at the revision the card showed. Null: cancelled. */
async function purgeCard(entries: readonly MemoryEntry[], context: MemoryCommandContext, io: WriteContext, body: readonly string[]): Promise<number | null> {
  const { locale } = io, sinks = sinksOf(context);
  if (!context.purgeMemory) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
  const picked = await io.ask({ title: t('memory.purge.card.title', { count: entries.length }, locale), body: [...body, '', t('memory.purge.card.scope', {}, locale)], options: reasonOptions(locale) });
  if (!picked || picked === 'cancel') return null;
  for (const entry of entries) {
    const result = await context.purgeMemory(io.root, { schemaVersion: 1, commandId: randomUUID(), scopeId: io.scope.scopeId, entryId: entry.entryId, expectedRevision: entry.revision,
      reasonCode: picked as typeof MEMORY_PURGE_REASONS[number] }, io.options);
    emit(t('memory.purge.done', { id: safeCell(entry.entryId), revisions: result.entry.revision, invocations: result.invocations.purged }, locale), sinks);
  }
  return entries.length;
}
async function contestCard(contest: MemoryContest, known: ReadonlyMap<string, MemoryEntry>, context: MemoryCommandContext, io: WriteContext, counts: Counts): Promise<boolean> {
  const { locale } = io, title = async (id: string) => {
    const entry = known.get(id) ?? (await io.resolve(id).then(found => found.status === 'ok' ? found.entry : null));
    return entry ? titleOf(entry, locale) : safeCell(id);
  };
  const picked = await io.ask({ title: t('memory.contest.card.title', {}, locale), body: [t('memory.contest.card.body', { record: safeCell(contest.evaluationRecordId),
    contestedId: safeCell(contest.entryId), contested: await title(contest.entryId), candidateId: safeCell(contest.candidateEntryId), candidate: await title(contest.candidateEntryId) }, locale)],
  options: [option('retire-contested', t('memory.contest.option.retire-contested', {}, locale), '1'), option('retire-candidate', t('memory.contest.option.retire-candidate', {}, locale), '2'),
    option('dismiss', t('memory.contest.option.dismiss', {}, locale), '3'), option('skip', t('memory.review.option.skip', {}, locale), 's'),
    option('stop', t('memory.review.option.stop', {}, locale), 'q')] });
  if (!picked || picked === 'stop') return false;
  if (picked === 'skip') { counts.skipped++; return true; }
  if (!context.resolveMemoryContest) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
  const decision = picked as 'retire-contested' | 'retire-candidate' | 'dismiss';
  await context.resolveMemoryContest(io.root, { schemaVersion: 1, commandId: randomUUID(), scopeId: io.scope.scopeId, contestId: contest.contestId, decision }, io.options);
  const label = decision === 'retire-contested' ? t('memory.contest.option.retire-contested', {}, locale) : decision === 'retire-candidate'
    ? t('memory.contest.option.retire-candidate', {}, locale) : t('memory.contest.option.dismiss', {}, locale);
  emit(t('memory.contest.done', { id: safeCell(contest.contestId), decision: label }, locale), sinksOf(context));
  counts.resolved++; return true;
}
/** One entry's card; false: the person stopped the review. */
async function itemCard(item: MemoryReviewItem, position: string, args: Parsed, context: MemoryCommandContext, io: WriteContext, counts: Counts): Promise<boolean> {
  const { locale } = io, { entry } = item, purged = isMemoryTombstone(entry.content), base = { schemaVersion: 1 as const, scopeId: io.scope.scopeId, entryId: entry.entryId, expectedRevision: entry.revision };
  const options = [...(entry.state === 'candidate' && !purged ? [option('verify', t('memory.review.option.verify', {}, locale), 'v')] : []),
    ...(entry.state !== 'retired' ? [option('retire', t('memory.review.option.retire', {}, locale), 'r')] : []), ...(purged ? [] : [option('purge', t('memory.review.option.purge', {}, locale), 'p')]),
    option('skip', t('memory.review.option.skip', {}, locale), 's'), option('stop', t('memory.review.option.stop', {}, locale), 'q')];
  const picked = await io.ask({ title: t('memory.review.card.title', { position }, locale), body: reviewLines(item, locale), options });
  if (!picked || picked === 'stop') return false;
  if (picked === 'verify') {
    if (!context.verifyMemory) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
    await context.verifyMemory(io.root, { ...base, commandId: randomUUID(), basis: { kind: 'human-review', note: args.note ?? t('memory.review.note.default', {}, locale) } }, io.options);
    counts.verified++;
  } else if (picked === 'retire') {
    if (!context.retireMemory) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
    await context.retireMemory(io.root, { ...base, commandId: randomUUID(), reason: args.reason ?? t('memory.review.reason.default', {}, locale), supersededBy: null }, io.options);
    counts.retired++;
  } else if (picked === 'purge') {
    if (await purgeCard([entry], context, io, reviewLines(item, locale)) === null) counts.skipped++; else counts.purged++;
  } else counts.skipped++;
  return true;
}

/**
 * `deckent memory review [--note <text>] [--reason <text>]` (S4B-4, owner S-M10/S-M12/S-M13): a person's cards over the scope's open contests,
 * then its candidates, contested and stale entries — each with its evidence, audience and every evaluator record (shadow ones verify nothing).
 * Entries the person may not read are only counted. Verify, retire, purge and contest decisions are applied one at a time as the person picks them.
 */
export async function memoryReview(args: Parsed, context: MemoryCommandContext, io: WriteContext): Promise<void | ExitCode> {
  const { locale } = io, sinks = sinksOf(context);
  if (!context.reviewMemory) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
  emit(scopeNotice(io.scope, locale), sinks);
  const review = await context.reviewMemory(io.root, { schemaVersion: 1, scopeId: io.scope.scopeId, limit: MEMORY_LIMITS.pageMax }, io.options);
  if (review.status === 'held') throw ErrorRegistry.createError(review.code);
  const lines = [review.items.length || review.contests.length ? t('memory.review.title', { scope: safeCell(io.scope.scopeId), items: review.items.length, contests: review.contests.length }, locale)
    : t('memory.review.none', {}, locale)];
  if (review.withheld) lines.push(t('memory.withheld', { count: review.withheld }, locale));
  if (!review.complete) lines.push(t('memory.review.incomplete', {}, locale));
  emit(lines.join('\n'), sinks);
  const counts: Counts = { verified: 0, retired: 0, purged: 0, resolved: 0, skipped: 0 }, known = new Map(review.items.map(item => [item.entry.entryId, item.entry] as const));
  let going = true;
  for (const contest of review.contests) if (going) going = await contestCard(contest, known, context, io, counts);
  const total = review.items.length;
  for (const [index, item] of review.items.entries()) if (going) going = await itemCard(item, `${index + 1}/${total}`, args, context, io, counts);
  emit(going ? t('memory.review.done', counts, locale) : `${t('memory.review.stopped', {}, locale)}\n${t('memory.review.done', counts, locale)}`, sinks);
}
async function sourceList(args: Parsed, context: MemoryCommandContext, io: WriteContext): Promise<Extract<MemorySourceEntries, { status: 'ok' }> | null> {
  if (!context.listMemorySource) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
  const listed = await context.listMemorySource(io.root, { schemaVersion: 1, scopeId: io.scope.scopeId, source: args.source!, limit: MEMORY_LIMITS.pageMax }, io.options);
  if (listed.status === 'held') throw ErrorRegistry.createError(listed.code);
  const sinks = sinksOf(context), lines: string[] = [];
  if (listed.withheld) lines.push(t('memory.withheld', { count: listed.withheld }, io.locale));
  if (!listed.complete) lines.push(t('memory.source.incomplete', { source: sourceText(args.source!) }, io.locale));
  if (lines.length) emit(lines.join('\n'), sinks);
  return listed;
}
const listing = (entries: readonly MemoryEntry[], locale: Locale) => entries.map(entry => `${safeCell(entry.entryId)} · ${state(entry.state, locale)} · ${titleOf(entry, locale)}`);
/** `deckent memory purge <id> | --source <run>[/<attempt>]` (A11): one card with the honest purge scope; the reason is picked on it. */
export async function memoryPurge(args: Parsed, context: MemoryCommandContext, io: WriteContext): Promise<void | ExitCode> {
  const { locale } = io, sinks = sinksOf(context), cancelled = () => { emit(t('memory.cancelled', {}, locale), { level: 'warning', ...sinks }); return EXIT_CODES.error; };
  emit(scopeNotice(io.scope, locale), sinks);
  if (args.source) {
    const listed = await sourceList(args, context, io), entries = (listed?.entries ?? []).filter(entry => !isMemoryTombstone(entry.content));
    if (!entries.length) { emit(t('memory.source.none', { source: sourceText(args.source) }, locale), sinks); return; }
    return await purgeCard(entries, context, io, listing(entries, locale)) === null ? cancelled() : undefined;
  }
  const found = await io.resolve(args.words[0]!);
  if (found.status === 'held') throw ErrorRegistry.createError(found.code);
  if (found.status === 'not-found') throw ErrorRegistry.createError('MEMORY_NOT_FOUND');
  if (isMemoryTombstone(found.entry.content)) throw ErrorRegistry.createError('MEMORY_TRANSITION_INVALID');
  return await purgeCard([found.entry], context, io, entryLines(found.entry, locale)) === null ? cancelled() : undefined;
}
/** `deckent memory retire --source <run>[/<attempt>] --reason <text>` (§6.5 bulk response to poisoning): one card, then each entry retired. */
export async function memoryRetireSource(args: Parsed, context: MemoryCommandContext, io: WriteContext): Promise<void | ExitCode> {
  const { locale } = io, sinks = sinksOf(context), source = sourceText(args.source!);
  emit(scopeNotice(io.scope, locale), sinks);
  if (!context.retireMemory) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
  const listed = await sourceList(args, context, io), entries = listed?.entries ?? [], open = entries.filter(entry => entry.state !== 'retired');
  if (!entries.length) { emit(t('memory.source.none', { source }, locale), sinks); return; }
  if (open.length && await io.ask({ title: t('memory.source.retire.title', { count: open.length, source }, locale), body: [...listing(open, locale), '',
    t('memory.source.retire.body', { reason: safeCell(args.reason!) }, locale)], options: cardOptions(locale) }) !== 'apply') {
    emit(t('memory.cancelled', {}, locale), { level: 'warning', ...sinks }); return EXIT_CODES.error;
  }
  for (const entry of open) await context.retireMemory(io.root, { schemaVersion: 1, commandId: randomUUID(), scopeId: io.scope.scopeId, entryId: entry.entryId,
    expectedRevision: entry.revision, reason: args.reason!, supersededBy: null }, io.options);
  emit(t('memory.source.retired', { count: open.length, source, skipped: entries.length - open.length }, locale), sinks);
}
