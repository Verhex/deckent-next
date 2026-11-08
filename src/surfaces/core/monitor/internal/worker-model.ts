import { t, type Locale } from '#platform/index.js';
import type { WorkerModelEvidence, WorkerModelVerdict, WorkerModelView } from '#domain/index.js';

const verdicts = (locale: Locale, provider: string): Readonly<Record<WorkerModelVerdict, string>> => ({ verified: t('cli.worker.model.verdict.verified', {}, locale),
  substituted: t('cli.worker.model.verdict.substituted', {}, locale), unverified: t('cli.worker.model.verdict.unverified', {}, locale),
  pending: t('cli.worker.model.verdict.pending', {}, locale), 'start-name-matched': t('cli.worker.model.verdict.start-name-matched', {}, locale),
  'provider-chosen': t('cli.worker.model.verdict.provider-chosen', { provider }, locale), 'client-reported': t('cli.worker.model.verdict.client-reported', { provider }, locale),
  'client-reported-mismatch': t('cli.worker.model.verdict.client-reported-mismatch', { provider }, locale) });
const evidence = (locale: Locale): Readonly<Record<WorkerModelEvidence, string>> => ({ sealed: t('cli.worker.model.evidence.sealed', {}, locale),
  invalid: t('cli.worker.model.evidence.invalid', {}, locale), live: t('cli.worker.model.evidence.live', {}, locale),
  none: t('cli.worker.model.evidence.none', {}, locale), denied: t('cli.worker.model.evidence.denied', {}, locale) });
const effortSources = (locale: Locale) => ({ explicit: t('cli.worker.effort.source.explicit', {}, locale),
  'policy-default': t('cli.worker.effort.source.policy-default', {}, locale), 'cli-default': t('cli.worker.effort.source.cli-default', {}, locale) });
const effortStatuses = (locale: Locale) => ({ selected: t('cli.worker.effort.status.selected', {}, locale),
  unsupported: t('cli.worker.effort.status.unsupported', {}, locale), 'cli-default': t('cli.worker.effort.status.cli-default', {}, locale),
  'ultra-opt-in-required': t('cli.worker.effort.status.ultra-opt-in-required', {}, locale) });
/** One line for every CLI view (workers list/watch, run inspect, task transcript): requested → init → usage → verdict (WORKER-CURRENCY-2). */
export function renderWorkerModelLine(view: WorkerModelView, locale: Locale): string {
  const none = t('cli.worker.model.none', {}, locale);
  return t('cli.worker.model.line', { requested: view.requested.modelId, channel: view.requested.channelId,
    auxiliary: view.requested.auxiliaryModelIds.join(', ') || none, init: view.init ?? none, usage: view.usage?.join(', ') || none,
    verdict: verdicts(locale, view.provider)[view.verdict], evidence: evidence(locale)[view.evidence] }, locale)
    + (view.reasoningEffort ? t('cli.worker.effort.line', { level: view.reasoningEffort.level ?? effortStatuses(locale)[view.reasoningEffort.status],
      source: effortSources(locale)[view.reasoningEffort.source],
      workClass: view.reasoningEffort.workClass ?? none }, locale) : '')
    + (view.reasoningEffort?.policyRevision ? t('cli.worker.effort.policy_revision', { revision: view.reasoningEffort.policyRevision }, locale) : '')
    + (view.unexpected.length ? t('cli.worker.model.unexpected', { models: view.unexpected.join(', ') }, locale) : '');
}
/** F2-11: the agent the system bound to a task and its pinned skill revisions (the plan card's words), for run and task inspect. */
export function renderTaskAgentLines(agent: Readonly<{ agentId: string; revision: number; standing: 'active' | 'candidate'; skills: readonly Readonly<{ skillId: string; revision: number }>[] }>, locale: Locale): string[] {
  return [t('agent.card.selected', { agentId: agent.agentId, revision: agent.revision, standing: agent.standing === 'active' ? t('agent.standing.active', {}, locale) : t('agent.standing.candidate', {}, locale) }, locale),
    ...(agent.skills.length ? [t('agent.card.skills', { skills: agent.skills.map(row => t('agent.card.skill', { skillId: row.skillId, revision: row.revision }, locale)).join(', ') }, locale)] : [])];
}
