import { ErrorRegistry, emit, loadConfig, t, type Locale } from '#platform/index.js';
import type { DecisionList } from '#engine/index.js';
import { cliMode, cliTableStyle, displayId, formatAgo, formatDecimal, renderCliTable, resolveCommandScope, safeCell, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import { cardIo, sinksOf } from '#surfaces/core/cli-approval/index.js';
import type { DecisionCommandContext } from './context.js';
import registry from './decision.json' with { type: 'json' };

type Item = DecisionList['items'][number];
const status = (item: Item, locale: Locale) => item.status === 'advised' ? t('decision.status.advised', {}, locale) : item.status === 'below-threshold'
  ? t('decision.status.below-threshold', {}, locale) : item.status === 'cancelled' ? t('decision.status.cancelled', {}, locale)
  : item.status === 'unavailable' ? t('decision.status.unavailable', {}, locale) : t('decision.status.unknown', {}, locale);

/** One decision in one window (owner: options, advice, selection and outcome together); probabilities as plain numbers, digests never. */
function decisionLines(item: Item, locale: Locale): readonly string[] {
  const advice = item.advice, record = item.record, chosen = record?.actor.selectedOption;
  return [t('cli.decide.view.objective', { objective: safeCell(item.case.objective) }, locale),
    t('cli.decide.view.status', { status: status(item, locale), asked: formatAgo(item.claimedAtMs, Date.now(), locale) }, locale),
    t('cli.decide.view.options', {}, locale),
    ...item.case.options.map(option => t('cli.decide.view.option', { id: safeCell(option.id), action: safeCell(option.action),
      probability: advice?.probabilities[option.id] === undefined ? '-' : formatDecimal(advice.probabilities[option.id]!, locale),
      mark: [advice?.choice === option.id ? t('cli.decide.view.advised', {}, locale) : '', chosen === option.id ? t('cli.decide.view.chosen', {}, locale) : ''].filter(Boolean).join(' · ') }, locale)),
    ...(advice ? [t('cli.decide.view.advice', { choice: safeCell(advice.choice), confidence: formatDecimal(advice.confidence, locale), sufficiency: formatDecimal(advice.sufficiency, locale),
      threshold: formatDecimal(item.thresholds.sufficiency, locale) }, locale)] : [t('decision.noAdvice', {}, locale)]),
    record ? t('cli.decide.view.selection', { option: safeCell(record.actor.selectedOption), rationale: safeCell(record.actor.rationale) }, locale) : t('cli.decide.view.noSelection', {}, locale),
    ...(record?.outcome ? [t('cli.decide.view.outcome', { observation: safeCell(record.outcome.observation), at: safeCell(record.outcome.observedAt) }, locale)] : []),
    t('decision.authorityNotice', {}, locale)];
}

/**
 * `deckent decide` without an action (owner 2026-10-19 beta part): the scope's recent decisions, newest first (read; the decision port's `inspect`
 * authorization). Table on a pipe, `--json` raw; on a person's terminal a decision can be opened in one window. Nothing is decided or recorded here:
 * the interactive "ask" form is post-beta.
 */
export async function recentDecisions(context: DecisionCommandContext, input: Readonly<{ locale: Locale; json: boolean; scope?: string }>): Promise<void> {
  const { locale } = input, root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, config = await loadConfig(root, options), sinks = sinksOf(context);
  if (!context.listDecisions) throw ErrorRegistry.createError('DECISION_UNAVAILABLE');
  const interactive = cliMode(context, input.json).mode === 'interactive', io = cardIo(context, locale, config.approvals.sessionTtlMs);
  const configured = (config.terminal as { scopeId?: unknown } | undefined)?.scopeId;
  const scope = await resolveCommandScope({ command: 'deckent decide', locale, explicit: input.scope, configured: typeof configured === 'string' ? configured : undefined,
    mutating: false, interactive, listScopes: scopeLister(context, root, options), pick: io.ask });
  if (!scope) return;
  const list = await context.listDecisions(root, { schemaVersion: 1, scopeId: scope.scopeId, limit: registry.list.limit }, options);
  if (input.json) { emit(list, { ...sinks, json: true }); return; }
  const ids = list.items.map(item => item.decisionId), now = Date.now();
  emit([scopeNotice(scope, locale), ...(list.items.length ? [renderCliTable([{ header: t('cli.decide.column.id', {}, locale) }, { header: t('cli.decide.column.asked', {}, locale) },
    { header: t('cli.decide.column.objective', {}, locale), shrink: true }, { header: t('cli.decide.column.advice', {}, locale) }, { header: t('cli.decide.column.selected', {}, locale) }],
  list.items.map(item => [displayId(item.decisionId, ids), formatAgo(item.claimedAtMs, now, locale), item.case.objective,
    item.advice ? `${status(item, locale)} · ${item.advice.choice}` : status(item, locale), item.record?.actor.selectedOption ?? '-']), cliTableStyle(context))]
    : [t('cli.decide.none', {}, locale)])].join('\n'), sinks);
  if (!interactive || !list.items.length) return;
  const picked = await io.ask({ title: t('cli.decide.pick.title', {}, locale), options: [...list.items.map(item => ({ id: item.decisionId,
    label: safeCell(`${displayId(item.decisionId, ids)} · ${item.case.objective}`) })), { id: '-leave', label: t('cli.decide.pick.leave', {}, locale), key: 'q' }] });
  const item = list.items.find(entry => entry.decisionId === picked);
  if (item) await io.ask({ title: t('cli.decide.view.title', { id: displayId(item.decisionId, ids) }, locale), body: decisionLines(item, locale),
    options: [{ id: 'close', label: t('cli.decide.view.close', {}, locale), key: 'q' }] });
}
