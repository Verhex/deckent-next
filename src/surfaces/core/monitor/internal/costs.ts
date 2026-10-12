import { t, terminalSafeText, type Locale } from '#platform/index.js';
import type { WorkCostReport } from '#domain/index.js';
const USD_NANOS_PER_UNIT = 1000000000n, USD_FRACTION_DIGITS = 9;
function money(amount: string | null | undefined, locale: Locale): string {
  if (amount == null) return t('resource.unknown', {}, locale);
  const nanos = BigInt(amount), fraction = (nanos % USD_NANOS_PER_UNIT).toString().padStart(USD_FRACTION_DIGITS, '0').replace(/0+$/, '');
  return `${nanos / USD_NANOS_PER_UNIT}${fraction ? '.' + fraction : ''}`;
}
export function renderCostSummary(report: WorkCostReport, locale: Locale): string {
  return t('resource.cost.summary', { run: terminalSafeText(report.runId), accepted: report.summary.acceptedTasks, failed: report.summary.failedTasks, unknown: report.summary.unknownTasks,
    cpu: report.summary.measuredCpuSeconds ?? t('resource.unknown', {}, locale), api: money(report.summary.measuredApiUsdNanos, locale),
    missing: report.summary.unknownApiAttempts, withheld: report.withheld }, locale);
}
export function renderCostReport(report: WorkCostReport, locale: Locale): string {
  const unknown = t('resource.unknown', {}, locale);
  const outcomes = { accepted: t('resource.cost.outcome.accepted', {}, locale), failed: t('resource.cost.outcome.failed', {}, locale),
    'awaiting-decision': t('resource.cost.outcome.awaiting', {}, locale), incomplete: t('resource.cost.outcome.incomplete', {}, locale) };
  return [renderCostSummary(report, locale), t('resource.cost.partial', {}, locale), ...report.attempts.map(row => t('resource.cost.attempt', {
    task: terminalSafeText(row.identity.taskId), attempt: terminalSafeText(row.identity.attemptId), workClass: terminalSafeText(row.acceptance.workClass ?? unknown),
    profile: terminalSafeText(`${row.profile.id}@${row.profile.version}`), model: terminalSafeText(row.model?.modelId ?? unknown), effort: terminalSafeText(row.effort ?? unknown),
    outcome: outcomes[row.acceptance.outcome], cpu: row.axes.cpuSeconds ?? unknown, peak: row.axes.sampledPeakBytes ?? unknown, wall: row.axes.wallMs ?? unknown,
    api: money(row.axes.apiMoney?.amountUsdNanos, locale), subscription: row.axes.subscription?.calls ?? unknown, subscriptionMs: row.axes.subscription?.durationMs ?? unknown,
    local: row.axes.localModel?.calls ?? unknown, human: row.axes.humanInterventions ?? unknown, rework: row.quality.reworkCount ?? unknown, rollback: row.quality.rollbackCount ?? unknown,
  }, locale)), ...renderRecommendationLines(report, locale)].join('\n');
}
export function renderRecommendationLines(report: WorkCostReport, locale: Locale): string[] {
  const axes = { 'cpu-seconds': t('resource.recommendation.axis.cpu', {}, locale), 'wall-ms': t('resource.recommendation.axis.wall', {}, locale),
    'api-usd-nanos': t('resource.recommendation.axis.api', {}, locale), 'subscription-ms': t('resource.recommendation.axis.subscription', {}, locale) };
  const states = { proposal: t('resource.recommendation.proposal', {}, locale), 'insufficient-evidence': t('resource.recommendation.insufficient', {}, locale),
    'quality-loss': t('resource.recommendation.veto', {}, locale), 'no-savings': t('resource.recommendation.noSavings', {}, locale) };
  const reasons = { 'paired-savings': t('resource.recommendation.reason.savings', {}, locale), 'unregistered-profile': t('resource.recommendation.reason.profile', {}, locale),
    'evidence-conflict': t('resource.recommendation.reason.conflict', {}, locale), 'unmatched-evidence': t('resource.recommendation.reason.unmatched', {}, locale),
    'quality-unknown': t('resource.recommendation.reason.quality', {}, locale), 'sample-size': t('resource.recommendation.reason.sample', {}, locale),
    'risk-bound': t('resource.recommendation.reason.risk', {}, locale), 'quality-regression': t('resource.recommendation.reason.loss', {}, locale),
    'cost-unknown': t('resource.recommendation.reason.cost', {}, locale), 'no-cost-gain': t('resource.recommendation.reason.noGain', {}, locale) };
  const lines = report.recommendations?.length ? report.recommendations.map(row => t('resource.recommendation.row', { state: states[row.state], workClass: terminalSafeText(row.workClass),
    baseline: terminalSafeText(row.baselineProfile), candidate: terminalSafeText(row.candidateProfile), reason: reasons[row.reason], pairs: row.evidencePairs,
    axis: axes[row.axis], risk: row.lossRiskUpper ?? t('resource.unknown', {}, locale), confidence: row.confidence,
    saving: row.savingFraction === null ? t('resource.unknown', {}, locale) : (row.savingFraction * 100).toFixed(2) }, locale))
    : [t('resource.recommendation.empty', {}, locale)];
  return [...lines, ...(report.recommendationsTruncated ? [t('resource.recommendation.truncated', {}, locale)] : [])];
}
