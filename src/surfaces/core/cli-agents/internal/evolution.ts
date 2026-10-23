import { randomUUID } from 'node:crypto';
import { ErrorRegistry, EXIT_CODES, emit, t, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import { STATS_MICRO, type AgentStanding } from '#domain/index.js';
import type { CatalogSuggestionView, KeyStats } from '#engine/index.js';
import { cliTableStyle, formatAgo, formatDecimal, renderCliTable, safeCell, scopeNotice, type CliCardRequest, type ScopeResolution } from '#surfaces/core/cli-human/index.js';
import { sinksOf } from '#surfaces/core/cli-approval/index.js';
import type { AgentsCommandContext } from './context.js';
import { counts, detailLines, modelLine } from './stats.js';
import limits from './limits.json' with { type: 'json' };

/** S8-3/S8-4 `deckent agents` suggestion and standing actions (S8-DESIGN §6, §7): the list and show read; every other action is one person's card. */
export const EVOLUTION_ACTIONS = ['suggestions', 'promote', 'demote', 'restore', 'retire', 'dismiss', 'standing'] as const;
export type EvolutionAction = typeof EVOLUTION_ACTIONS[number];
interface Io { readonly root: string; readonly options: ConfigLoadOptions; readonly locale: Locale; readonly scope: ScopeResolution; readonly json: boolean;
  readonly ask: (request: CliCardRequest) => Promise<string | null> }
type Args = { readonly words: readonly string[]; readonly workClass?: string | undefined; readonly suggestion?: string | undefined; readonly fromSuggestion?: string | undefined; readonly id?: string | undefined };
const need = <T>(value: T | undefined): T => { if (!value) throw ErrorRegistry.createError('AGENT_CATALOG_UNAVAILABLE'); return value; };
const options = (locale: Locale) => [{ id: 'apply', label: t('agents.card.apply', {}, locale), key: 'y' }, { id: 'cancel', label: t('agents.card.cancel', {}, locale), key: 'n' }];
const standingLabel = (standing: string, locale: Locale) => standing === 'active' ? t('agent.standing.active', {}, locale) : standing === 'candidate' ? t('agent.standing.candidate', {}, locale)
  : standing === 'retired' ? t('agent.standing.retired', {}, locale) : t('agent.standing.redesign-required', {}, locale);
const TO = { promote: 'active', demote: 'candidate', restore: 'candidate', retire: 'retired' } as const;
type Move = keyof typeof TO;
const title = (action: Move, locale: Locale) => action === 'promote' ? t('agentsevo.card.title.promote', {}, locale) : action === 'demote' ? t('agentsevo.card.title.demote', {}, locale)
  : action === 'restore' ? t('agentsevo.card.title.restore', {}, locale) : t('agentsevo.card.title.retire', {}, locale);
const effect = (action: Move, locale: Locale) => action === 'promote' ? t('agentsevo.card.effect.promote', {}, locale) : action === 'demote' ? t('agentsevo.card.effect.demote', {}, locale)
  : action === 'restore' ? t('agentsevo.card.effect.restore', {}, locale) : t('agentsevo.card.effect.retire', {}, locale);
const kindLabel = (kind: CatalogSuggestionView['kind'], locale: Locale) => kind === 'promote-agent' ? t('agentsevo.kind.promote', {}, locale) : kind === 'redesign-agent' ? t('agentsevo.kind.redesign', {}, locale)
  : kind === 'revise-agent' ? t('agentsevo.kind.revise', {}, locale) : kind === 'propose-agent' ? t('agentsevo.kind.proposeAgent', {}, locale) : t('agentsevo.kind.proposeSkill', {}, locale);
const stateLabel = (state: CatalogSuggestionView['state'], locale: Locale) => state === 'open' ? t('agentsevo.state.open', {}, locale) : state === 'decided' ? t('agentsevo.state.decided', {}, locale)
  : state === 'dismissed' ? t('agentsevo.state.dismissed', {}, locale) : state === 'expired' ? t('agentsevo.state.expired', {}, locale) : t('agentsevo.state.superseded', {}, locale);
const keyLabel = (key: CatalogSuggestionView['key'], locale: Locale) => key.kind === 'agent' ? t('agentsevo.key.agent', { id: safeCell(key.agentId), revision: key.revision, workClass: safeCell(key.workClass) }, locale)
  : key.kind === 'work-class' ? t('agentsevo.key.workClass', { workClass: safeCell(key.workClass) }, locale)
    : t('agentsevo.key.audience', { family: key.workClassFamily ? safeCell(key.workClassFamily) : t('agentsevo.key.scopeWide', {}, locale), target: key.workTargetId ? safeCell(key.workTargetId) : '-' }, locale);
const short = (id: string) => id.slice(0, 12);
/** The table of suggestions: id, kind, key, state (shadow marked), evidence, age. */
function suggestionTable(items: readonly CatalogSuggestionView[], locale: Locale, context: AgentsCommandContext): string {
  const now = Date.now();
  return renderCliTable([{ header: t('agentsevo.column.id', {}, locale) }, { header: t('agentsevo.column.kind', {}, locale) }, { header: t('agentsevo.column.key', {}, locale), shrink: true },
    { header: t('agentsevo.column.state', {}, locale) }, { header: t('agentsevo.column.evidence', {}, locale) }, { header: t('agentsevo.column.age', {}, locale) }],
  items.map(row => [short(row.suggestionId), kindLabel(row.kind, locale), keyLabel(row.key, locale),
    `${stateLabel(row.state, locale)}${row.mode === 'shadow' ? ` · ${t('agentsevo.mode.shadow', {}, locale)}` : ''}`, t('agentsevo.evidence', { n: row.window.n }, locale), formatAgo(row.asOfMs, now, locale)]),
  cliTableStyle(context));
}
/** Everything a card or `show` says about one suggestion: the sealed numbers beside the WorkClass and the promoted agent, every failure bucket, the labels;
 * a skill draft's lesson refs only where the reader may read them (the rest a count). Never draft or lesson text. */
export function suggestionLines(view: CatalogSuggestionView, locale: Locale): string[] {
  const stats = view.stats as KeyStats | null, baseline = view.baseline as KeyStats | null, active = view.active as { agentId: string; revision: number; stats: KeyStats } | null, p = view.proposed;
  const lines = [t('agentsevo.show.head', { id: view.suggestionId, kind: kindLabel(view.kind, locale), state: stateLabel(view.state, locale) }, locale), t('agentsevo.labels', {}, locale),
    t('agentsevo.show.key', { key: keyLabel(view.key, locale) }, locale),
    t('agentsevo.show.rule', { rule: safeCell(`${view.rule.id}@${view.rule.version}`), status: view.rule.status === 'calibrated' ? t('agentsevo.rule.calibrated', {}, locale) : t('agentsevo.rule.provisional', {}, locale) }, locale),
    ...view.mode === 'shadow' ? [t('agentsevo.show.shadow', {}, locale)] : []];
  if (stats) lines.push(t('agentsevo.show.window', { line: counts(stats, locale), digest: short(view.window.inputDigest) }, locale), ...detailLines(stats, locale), ...modelLine(stats, locale));
  if (baseline) lines.push(t('agentstats.baseline', { line: counts(baseline, locale), ratio: view.effortRatioMicro === null ? t('agentstats.ratio.none', {}, locale) : formatDecimal(view.effortRatioMicro / STATS_MICRO, locale, 2) }, locale));
  if (active) lines.push(t('agentstats.active', { id: safeCell(active.agentId), revision: active.revision, line: counts(active.stats, locale) }, locale));
  if (view.kind === 'promote-agent') lines.push(t('agentsevo.show.weakFilter', {}, locale));
  lines.push(p.kind === 'standing' ? t('agentsevo.show.proposeStanding', { standing: standingLabel(p.to, locale) }, locale) : p.kind === 'revise' ? t('agentsevo.show.proposeRevise', {}, locale)
    : p.kind === 'agent-draft' ? t('agentsevo.show.proposeAgentDraft', { template: safeCell(p.template) }, locale)
      : t('agentsevo.show.proposeSkillDraft', { template: safeCell(p.template), shown: p.lessons.length, withheld: 'withheld' in p ? p.withheld : 0 }, locale));
  if (p.kind === 'skill-draft') lines.push(...p.lessons.map(ref => `    ${safeCell(ref.entryId)}@${ref.revision} ${short(ref.contentDigest)}`));
  if (view.decidedBy) lines.push(t('agentsevo.show.decided', { by: safeCell(`${view.decidedBy.issuer}:${view.decidedBy.subject}`), decision: safeCell(view.decision ?? '-') }, locale));
  if (view.signerRevoked) lines.push(t('agentsign.view.signerRevoked', {}, locale));
  lines.push(t('agentsevo.show.producer', { producer: safeCell(`${view.producer.issuer}:${view.producer.subject}`), ago: formatAgo(view.asOfMs, Date.now(), locale) }, locale));
  return lines;
}
/** A full suggestion id, or a unique prefix of at least the shown 12 characters among the newest listed. */
export async function resolveSuggestion(prefix: string, context: AgentsCommandContext, io: Pick<Io, 'root' | 'options' | 'scope'>): Promise<CatalogSuggestionView> {
  const scopeId = io.scope.scopeId, wanted = prefix.toLowerCase();
  if (/^[a-f0-9]{64}$/.test(wanted)) {
    const shown = await need(context.inspectSuggestion)(io.root, { schemaVersion: 1, scopeId, suggestionId: wanted }, io.options);
    if (shown.status === 'ok') return shown.item;
  }
  const rows = wanted.length >= 12 ? (await need(context.listSuggestions)(io.root, { schemaVersion: 1, scopeId, limit: limits.list.limit }, io.options)).items.filter(row => row.suggestionId.startsWith(wanted)) : [];
  if (rows.length !== 1) throw ErrorRegistry.createError('AGENT_CATALOG_NOT_FOUND');
  return rows[0]!;
}

/** `deckent agents suggestions [list | show <id>]`, the standing cards, `dismiss <id>` and `standing reset --work-class <id>`. */
export async function evolutionCommand(action: EvolutionAction, args: Args, context: AgentsCommandContext, io: Io): Promise<void | ExitCode> {
  const { locale, scope } = io, sinks = sinksOf(context), scopeId = scope.scopeId;
  const card = async (title: string, body: string[]) => await io.ask({ title, body, options: options(locale) }) === 'apply';
  const cancelled = () => { emit(t('agents.cancelled', {}, locale), { level: 'warning', ...sinks }); return EXIT_CODES.error; };
  if (action === 'suggestions') {
    const [word = 'list', id] = args.words;
    if (word === 'show' && id) {
      const view = await resolveSuggestion(id, context, io);
      if (io.json) emit(view, { ...sinks, json: true }); else emit([scopeNotice(scope, locale), ...suggestionLines(view, locale)].join('\n'), sinks);
      return;
    }
    if (word !== 'list' || id) throw ErrorRegistry.createError('CLI_USAGE');
    const listing = await need(context.listSuggestions)(io.root, { schemaVersion: 1, scopeId, limit: limits.list.limit }, io.options);
    if (io.json) { emit(listing, { ...sinks, json: true }); return; }
    emit([scopeNotice(scope, locale), t('agentsevo.labels', {}, locale), listing.items.length ? suggestionTable(listing.items, locale, context) : t('agentsevo.none', {}, locale)].join('\n'), sinks);
    return;
  }
  emit(scopeNotice(scope, locale), sinks);
  if (action === 'dismiss') {
    const view = await resolveSuggestion(args.words[0]!, context, io);
    if (!await card(t('agentsevo.card.dismiss.title', {}, locale), [...suggestionLines(view, locale), '', t('agentsevo.card.dismiss.body', {}, locale)])) return cancelled();
    await need(context.dismissSuggestion)(io.root, { schemaVersion: 1, scopeId, commandId: randomUUID(), suggestionId: view.suggestionId, expectedStateRevision: view.stateRevision }, io.options);
    emit(t('agentsevo.done.dismiss', { id: short(view.suggestionId) }, locale), sinks); return;
  }
  const workClass = args.workClass!;
  if (action === 'standing') {
    if (args.words[0] !== 'reset') throw ErrorRegistry.createError('CLI_USAGE');
    const rows: AgentStanding[] = [];
    for (const agent of (await need(context.listAgents)(io.root, { schemaVersion: 1, scopeId, limit: limits.reset.limit }, io.options)).items) {
      const shown = await need(context.inspectAgent)(io.root, { schemaVersion: 1, scopeId, agentId: agent.agentId }, io.options);
      const row = shown.status === 'ok' ? shown.standings.find(value => value.workClass === workClass) : undefined;
      if (row && (row.standing === 'active' || row.standing === 'redesign-required')) rows.push(row);
    }
    if (!rows.length) { emit(t('agentsevo.reset.none', { workClass: safeCell(workClass) }, locale), sinks); return; }
    if (!await card(t('agentsevo.card.reset.title', { workClass: safeCell(workClass) }, locale), [...rows.map(row => t('agentsevo.card.reset.row', { id: safeCell(row.agentId), revision: row.revision,
      standing: standingLabel(row.standing, locale) }, locale)), '', t('agentsevo.card.reset.body', {}, locale)])) return cancelled();
    await need(context.bulkStanding)(io.root, { schemaVersion: 1, scopeId, commandId: randomUUID(), reason: { kind: 'reset', workClass },
      targets: rows.map(row => ({ agentId: row.agentId, revision: row.revision, workClass, expectedStandingRevision: row.standingRevision })) }, io.options);
    emit(t('agentsevo.done.reset', { count: rows.length, workClass: safeCell(workClass) }, locale), sinks); return;
  }
  // promote | demote | restore | retire one agent's current revision for one WorkClass.
  const agentId = args.words[0]!, shown = await need(context.inspectAgent)(io.root, { schemaVersion: 1, scopeId, agentId }, io.options);
  if (shown.status !== 'ok') throw ErrorRegistry.createError('AGENT_CATALOG_NOT_FOUND');
  const standing = shown.standings.find(row => row.workClass === workClass);
  if (!standing) throw ErrorRegistry.createError('AGENT_STANDING_REFUSED');
  const kind = action === 'promote' ? 'promote-agent' : 'redesign-agent', revision = shown.item.revision;
  // The card decides the open live suggestion of this key and kind (named or found); without one it says no sealed suggestion backs it.
  const suggestion = args.suggestion ? await resolveSuggestion(args.suggestion, context, io)
    : (await need(context.listSuggestions)(io.root, { schemaVersion: 1, scopeId, limit: limits.list.limit }, io.options)).items.find(row => row.state === 'open' && row.mode === 'on' && row.kind === kind
      && row.key.kind === 'agent' && row.key.agentId === agentId && row.key.revision === revision && row.key.workClass === workClass) ?? null;
  const author = shown.item.provenance.author;
  const body = [t('agentsevo.card.move', { id: safeCell(agentId), revision, workClass: safeCell(workClass), from: standingLabel(standing.standing, locale), to: standingLabel(TO[action], locale) }, locale),
    ...suggestion ? suggestionLines(suggestion, locale) : [t('agentsevo.card.noSuggestion', { id: safeCell(agentId) }, locale)],
    ...author.ai ? [t('agentsevo.card.aiAuthor', { author: safeCell(`${author.issuer}:${author.subject}`) }, locale)] : [],
    ...standing.basis.kind === 'inherited' ? [t('agentsevo.view.inherited', { from: standing.basis.fromRevision ?? '-' }, locale)] : [],
    '', effect(action, locale)];
  if (!await card(title(action, locale), body)) return cancelled();
  const done = await need(context.changeStanding)(io.root, { schemaVersion: 1, scopeId, commandId: randomUUID(), action, agentId, revision, workClass,
    expectedStandingRevision: standing.standingRevision, suggestionId: suggestion?.suggestionId ?? null }, io.options);
  emit(t('agentsevo.done.move', { id: safeCell(agentId), workClass: safeCell(workClass), standing: standingLabel(done.standings[0]?.standing ?? TO[action], locale),
    displaced: done.standings.length > 1 ? t('agentsevo.done.displaced', { id: safeCell(done.standings[1]!.agentId) }, locale) : '' }, locale), sinks);
}

/** `deckent agents define --from-suggestion <id> --id <agent-id>` / `define-skill …`: the draft rendered now from what you may read, on one card. */
export async function draftDefine(action: 'define' | 'define-skill', args: Args, context: AgentsCommandContext, io: Io): Promise<void | ExitCode> {
  const { locale, scope } = io, sinks = sinksOf(context), scopeId = scope.scopeId;
  emit(scopeNotice(scope, locale), sinks);
  const view = await resolveSuggestion(args.fromSuggestion!, context, io);
  if ((action === 'define') !== (view.kind === 'propose-agent')) throw ErrorRegistry.createError('CATALOG_SUGGESTION_STALE');
  const shown = await need(context.draftSuggestion)(io.root, { schemaVersion: 1, scopeId, suggestionId: view.suggestionId }, io.options), draft = shown.draft;
  const current = draft.kind === 'agent' ? await need(context.inspectAgent)(io.root, { schemaVersion: 1, scopeId, agentId: args.id! }, io.options)
    : await need(context.inspectSkill)(io.root, { schemaVersion: 1, scopeId, skillId: args.id! }, io.options);
  const expectedRevision = current.status === 'ok' ? current.item.revision : null;
  const body = [...draft.kind === 'agent' ? [`${safeCell(args.id!)} · ${safeCell(draft.content.name)}`, safeCell(draft.content.persona), t('agents.view.workClasses', { classes: draft.content.workClasses.map(row => safeCell(row)).join(', ') }, locale)]
    : [`${safeCell(args.id!)} · ${safeCell(draft.content.name)}`, safeCell(draft.content.text), t('agentsevo.draft.lessons', { count: draft.lessons, omitted: draft.omitted, withheld: shown.withheld }, locale)],
  '', ...shown.aiDerived ? [t('agentsevo.draft.aiDerived', {}, locale)] : [], t('agentsevo.draft.body', { suggestion: short(view.suggestionId) }, locale),
  expectedRevision === null ? t('agents.card.new', {}, locale) : t('agents.card.revision', { from: expectedRevision, to: expectedRevision + 1 }, locale)];
  if (await io.ask({ title: draft.kind === 'agent' ? t('agentsevo.draft.title.agent', {}, locale) : t('agentsevo.draft.title.skill', {}, locale), body, options: options(locale) }) !== 'apply') {
    emit(t('agents.cancelled', {}, locale), { level: 'warning', ...sinks }); return EXIT_CODES.error;
  }
  const done = await need(context.defineFromSuggestion)(io.root, { schemaVersion: 1, scopeId, suggestionId: view.suggestionId, id: args.id!, expectedRevision, draftDigest: shown.digest, commandId: randomUUID() }, io.options);
  emit('agentId' in done.item ? t('agents.done.agent', { id: done.item.agentId, revision: done.item.revision }, locale) : t('agents.done.skill', { id: done.item.skillId, revision: done.item.revision }, locale), sinks);
}

/** S8-4 (owner Q-S13): after a revoke card, the promotions the key signed that are still in effect, with a one-step demote (a person's card). */
export async function revokedPromotionsCard(keyId: string, context: AgentsCommandContext, io: Io): Promise<void | ExitCode> {
  const { locale } = io, sinks = sinksOf(context), scopeId = io.scope.scopeId;
  if (!context.listRevokedPromotions || !context.bulkStanding) return;
  const rows = await context.listRevokedPromotions(io.root, { schemaVersion: 1, scopeId, keyId }, io.options);
  if (!rows.length) return;
  const lines = rows.map(row => t('agentsevo.card.reset.row', { id: safeCell(row.standing.agentId), revision: row.standing.revision, standing: `${standingLabel(row.standing.standing, locale)} · ${safeCell(row.standing.workClass)}` }, locale));
  if (await io.ask({ title: t('agentsevo.revoked.title', { count: rows.length }, locale), body: [...lines, '', t('agentsevo.revoked.body', {}, locale)], options: options(locale) }) !== 'apply') {
    emit(t('agentsevo.revoked.kept', { count: rows.length }, locale), { level: 'warning', ...sinks }); return;
  }
  await context.bulkStanding(io.root, { schemaVersion: 1, scopeId, commandId: randomUUID(), reason: { kind: 'signer-revoked', keyId },
    targets: rows.map(row => ({ agentId: row.standing.agentId, revision: row.standing.revision, workClass: row.standing.workClass, expectedStandingRevision: row.standing.standingRevision })) }, io.options);
  emit(t('agentsevo.revoked.done', { count: rows.length }, locale), sinks);
}
