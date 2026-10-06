import { redactSensitive, terminalSafeText, t, type Locale } from '#platform/index.js';
import type { TaskBrief, ResultBrief } from '#engine/index.js';
import { deliveryLabel, verdictLabel } from './labels.js';
const safe = (text: string) => redactSensitive(terminalSafeText(text));
/** Shared EN/TR wording for worker detail and run inspect. Labels never turn worker reports into evaluation evidence. */
export function renderBriefLines(task: TaskBrief | undefined, result: ResultBrief | undefined, locale: Locale): string[] {
  const missing = t('monitor.brief.missing', {}, locale);
  const lines: string[] = [];
  if (task) {
    lines.push(t('monitor.brief.task', { value: task.task ? safe(task.task) : missing }, locale),
      t('monitor.brief.scope', { value: task.scopePaths ? task.scopePaths.map(safe).join(', ') : missing }, locale),
      t('monitor.brief.acceptance', { value: task.acceptance ? safe(task.acceptance) : missing }, locale),
      t('monitor.brief.profile', { value: task.profile ? `${safe(task.profile.id)}@${task.profile.version}` : missing }, locale),
      t('monitor.brief.model', { value: task.model ? `${safe(task.model.channelId)}/${safe(task.model.modelId)}` : missing }, locale),
      t('monitor.brief.effort', { value: task.effort ? safe(task.effort) : missing }, locale),
      t('monitor.brief.context', { value: task.contextRefs.length ? task.contextRefs.map(ref => `${safe(ref.id)}@${ref.version} (${ref.sha256})`).join(', ') : missing }, locale));
    for (const criterion of task.criteria) lines.push(t('monitor.brief.criterion', { id: safe(criterion.id), value: safe(criterion.description), evaluator: `${safe(criterion.evaluator.id)}@${criterion.evaluator.version}` }, locale));
  }
  const checks = { passed: t('monitor.human.passed', {}, locale), failed: t('monitor.human.failed', {}, locale),
    'not-run': t('monitor.human.notRun', {}, locale), unknown: t('monitor.human.unknown', {}, locale) };
  if (result) {
    lines.push(t('monitor.human.evaluation', { verdict: verdictLabel(result.evaluation.verdict, locale) }, locale)
      + (result.evaluation.reason ? ` · ${t('task.acceptance.noChangeProduced', {}, locale)}` : ''));
    const report = result.report?.status === 'reported' ? result.report.report : null;
    if (report) {
      lines.push(t('monitor.brief.claim', { value: safe(report.summary) }, locale),
        t('monitor.brief.claimFiles', { value: report.changedFiles.map(safe).join(', ') || t('monitor.brief.noneReported', {}, locale) }, locale));
      for (const check of report.checks) lines.push(t('monitor.brief.claimCheck', { command: safe(check.command), outcome: checks[check.outcome] }, locale));
      lines.push(t('monitor.brief.openIssues', { value: result.openIssues?.map(safe).join('; ') || t('monitor.brief.noneReported', {}, locale) }, locale));
    } else {
      lines.push(t('monitor.human.reportMissing', {}, locale), t('monitor.brief.openIssues', { value: missing }, locale));
    }
    const receipts = result.runDelivery?.receipts ?? (result.runDelivery ? [result.runDelivery] : []);
    for (const receipt of receipts) lines.push(t('monitor.brief.runReceipt', { state: deliveryLabel(receipt.state, locale), command: receipt.commandId ? safe(receipt.commandId) : missing,
      target: receipt.targetRef ? safe(receipt.targetRef) : missing, commit: receipt.commit ?? missing }, locale));
    if (result.failedTests) {
      lines.push(t('monitor.brief.failedTests', { count: result.failedTests.count, shown: result.failedTests.names.length, names: result.failedTests.names.map(safe).join('; ') }, locale));
      if (result.failedTests.count > result.failedTests.names.length) lines.push(t('monitor.brief.failedTestsMore', { more: result.failedTests.count - result.failedTests.names.length }, locale));
    }
    const outlook = result.deliveryOutlook === 'none' ? t('monitor.brief.deliveryNone', {}, locale) : result.deliveryOutlook === 'patch-not-prepared' ? t('monitor.brief.deliveryPatchNotPrepared', {}, locale)
      : result.deliveryOutlook === 'awaiting-delivery' ? t('monitor.brief.deliveryAwaiting', {}, locale) : null;
    lines.push(receipts.length ? t('monitor.brief.attribution', {}, locale) : outlook ?? t('monitor.brief.deliveryMissing', {}, locale));
  }
  return lines;
}
