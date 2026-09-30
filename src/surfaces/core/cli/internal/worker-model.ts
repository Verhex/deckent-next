import { t, type Locale } from '#platform/index.js';
import type { WorkerModelEvidence, WorkerModelVerdict, WorkerModelView } from '#domain/index.js';

const verdicts = (locale: Locale): Readonly<Record<WorkerModelVerdict, string>> => ({ verified: t('cli.worker.model.verdict.verified', {}, locale),
  substituted: t('cli.worker.model.verdict.substituted', {}, locale), unverified: t('cli.worker.model.verdict.unverified', {}, locale),
  pending: t('cli.worker.model.verdict.pending', {}, locale) });
const evidence = (locale: Locale): Readonly<Record<WorkerModelEvidence, string>> => ({ sealed: t('cli.worker.model.evidence.sealed', {}, locale),
  invalid: t('cli.worker.model.evidence.invalid', {}, locale), live: t('cli.worker.model.evidence.live', {}, locale),
  none: t('cli.worker.model.evidence.none', {}, locale), denied: t('cli.worker.model.evidence.denied', {}, locale) });
/** One line for every CLI view (workers list/watch, run inspect, task transcript): requested → init → usage → verdict (WORKER-CURRENCY-2). */
export function renderWorkerModelLine(view: WorkerModelView, locale: Locale): string {
  const none = t('cli.worker.model.none', {}, locale);
  return t('cli.worker.model.line', { requested: view.requested.modelId, channel: view.requested.channelId,
    auxiliary: view.requested.auxiliaryModelIds.join(', ') || none, init: view.init ?? none, usage: view.usage?.join(', ') || none,
    verdict: verdicts(locale)[view.verdict], evidence: evidence(locale)[view.evidence] }, locale)
    + (view.unexpected.length ? t('cli.worker.model.unexpected', { models: view.unexpected.join(', ') }, locale) : '');
}
