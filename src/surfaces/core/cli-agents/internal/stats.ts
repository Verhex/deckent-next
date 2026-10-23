import { t, type Locale } from '#platform/index.js';
import { STATS_MICRO } from '#domain/index.js';
import type { AgentStatsView, KeyStats, RollupStats } from '#engine/index.js';
import { formatAgo, formatDecimal, formatDuration, formatUsd, safeCell } from '#surfaces/core/cli-human/index.js';

const NANOS_PER_USD = 1e9, PERCENT = 100;
const percent = (micro: number, locale: Locale) => t('agentstats.percent', { n: formatDecimal((micro * PERCENT) / STATS_MICRO, locale, 1) }, locale);
const counts = (row: Pick<KeyStats, 'successes' | 'n' | 'decided' | 'wilson'>, locale: Locale) => t('agentstats.counts', { successes: row.successes, n: row.n, decided: row.decided,
  interval: row.wilson ? t('agentstats.interval', { lower: percent(row.wilson.lowerMicro, locale), upper: percent(row.wilson.upperMicro, locale) }, locale) : t('agentstats.interval.none', {}, locale) }, locale);
const standingLabel = (standing: string | null, locale: Locale) => standing === 'active' ? t('agent.standing.active', {}, locale) : standing === 'candidate' ? t('agent.standing.candidate', {}, locale)
  : standing === 'redesign-required' ? t('agent.standing.redesign-required', {}, locale) : standing === 'retired' ? t('agent.standing.retired', {}, locale) : t('agentstats.standing.none', {}, locale);
const modeLine = (mode: string, locale: Locale) => mode === 'shadow' ? t('agentstats.mode.shadow', {}, locale) : mode === 'on' ? t('agentstats.mode.on', {}, locale) : t('agentstats.mode.off', {}, locale);
/** The failure buckets and set-apart counts of one key: what counted against the agent and what never did (S8-DESIGN §4 fold B). */
const detailLines = (row: KeyStats, locale: Locale) => [
  t('agentstats.effort', { p50: formatDuration(row.effort.p50Ms, locale), p90: formatDuration(row.effort.p90Ms, locale), quota: row.excluded.quotaPark, human: row.effort.humanDecisions,
    cost: row.effort.costUsdNanos === null ? t('agentstats.cost.none', {}, locale) : formatUsd(Number(row.effort.costUsdNanos) / NANOS_PER_USD, locale) }, locale),
  t('agentstats.failures', { criteria: row.failures['criteria-failed'] ?? 0, report: row.failures['worker-report-failed'] ?? 0, human: row.failures['human-rejected'] ?? 0 }, locale),
  t('agentstats.uncounted', { infra: row.unattributable['infra'] ?? 0, model: row.unattributable['model'] ?? 0, dependency: row.unattributable['dependency'] ?? 0,
    policy: row.unattributable['policy'] ?? 0, operator: row.unattributable['operator'] ?? 0, unattributed: row.unattributable['unattributed'] ?? 0 }, locale),
  t('agentstats.excluded', { awaiting: row.excluded.awaitingDecision, unknown: row.excluded.unknownEvidence, legacy: row.excluded.legacy, undated: row.excluded.undated,
    incomplete: row.excluded.runIncomplete }, locale)];
const modelLine = (row: KeyStats, locale: Locale) => row.perModel?.length ? [t('agentstats.models', { models: [...row.perModel.map(model => t('agentstats.model', {
  model: model.modelId === null ? t('agentstats.model.none', {}, locale) : safeCell(`${model.channelId}/${model.modelId}`), maker: safeCell(model.maker), tier: safeCell(model.tier),
  successes: model.successes, n: model.n }, locale)), ...row.otherModels ? [t('agentstats.models.other', { n: row.otherModels }, locale)] : []].join('; ') }, locale)] : [];
const rollupLine = (row: RollupStats, locale: Locale) => t('agentstats.rollup', { workClass: safeCell(row.workClass), members: row.members, line: counts(row, locale) }, locale);

/** `deckent agents stats`: the labels first (association, acceptance rate), then each agent key beside its WorkClass baseline and promoted agent. */
export function agentStatsView(view: AgentStatsView, locale: Locale, nowMs = Date.now()): string {
  const lines = [t('agentstats.title', {}, locale), modeLine(view.mode, locale),
    t('agentstats.registry', { revision: safeCell(view.registry.revision), status: view.registry.status === 'calibrated' ? t('agentstats.registry.calibrated', {}, locale) : t('agentstats.registry.provisional', {}, locale), rows: view.rows.read,
      truncated: view.rows.truncated ? t('agentstats.truncated', {}, locale) : '' }, locale),
    view.lastPass ? t('agentstats.lastPass', { position: view.lastPass.position, keys: view.lastPass.keys.length, mode: modeLine(view.lastPass.mode, locale),
      ago: formatAgo(view.lastPass.asOfMs, nowMs, locale) }, locale) : t('agentstats.lastPass.none', {}, locale)];
  if (!view.agents.length) return [...lines, t('agentstats.none', {}, locale)].join('\n');
  for (const agent of view.agents) {
    lines.push('', t('agentstats.agent', { id: safeCell(agent.agentId), name: safeCell(agent.name), revision: agent.revision }, locale));
    for (const key of agent.keys) {
      lines.push(t('agentstats.key', { workClass: safeCell(key.workClass), revision: key.revision, standing: standingLabel(key.standing, locale), line: counts(key.stats, locale) }, locale),
        ...detailLines(key.stats, locale), ...modelLine(key.stats, locale),
        t('agentstats.baseline', { line: counts(key.baseline, locale), ratio: key.effortRatioMicro === null ? t('agentstats.ratio.none', {}, locale) : formatDecimal(key.effortRatioMicro / STATS_MICRO, locale, 2) }, locale),
        ...key.active ? [t('agentstats.active', { id: safeCell(key.active.agentId), revision: key.active.revision, line: counts(key.active.stats, locale) }, locale)] : [],
        ...(key.skills ?? []).map(skill => t('agentstats.skill', { id: safeCell(skill.skillId), revision: skill.revision, line: counts(skill.stats, locale) }, locale)));
    }
    lines.push(...agent.rollup.map(row => rollupLine(row, locale)));
  }
  if (view.workClasses.length) lines.push('', t('agentstats.workClasses', {}, locale),
    ...view.workClasses.map(row => t('agentstats.workClass', { workClass: safeCell(row.workClass), line: counts(row.stats, locale) }, locale)));
  return lines.join('\n');
}
