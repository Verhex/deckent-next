import { redactSensitive, terminalSafeText, t, type Locale } from '#platform/index.js';
import type { TaskBrief, ResultBrief } from '#engine/index.js';
import type { WorkerFinalReport } from '#domain/index.js';
import { acceptanceEvidenceQualifier } from '#surfaces/core/cli-human/index.js';
import { deliveryLabel, notAcceptedLabel, verdictLabel } from './labels.js';
const safe = (text: string) => redactSensitive(terminalSafeText(text));
const MEMORY_PART = /^memory-[a-f0-9]{16}$/u;
/** F2-6: a generated hex id inside a human line (a profile's digest tail, a sha256, a delivery ref) shows its 8-character head; commands keep theirs whole. */
const short = (text: string) => text.replace(/[0-9a-f]{32,}/giu, hex => hex.slice(0, 8));
/** PRE-1 B3: an `accepted` verdict names what it rests on (one shared label); callers that print it separately skip theirs when this is true. */
export const briefQualifiesAcceptance = (task: TaskBrief | undefined, verdict: ResultBrief['evaluation']['verdict']) => verdict === 'accepted' && !!task?.criteria.length;
export function evaluationText(task: TaskBrief | undefined, evaluation: ResultBrief['evaluation'], locale: Locale): string {
  return t('monitor.human.evaluation', { verdict: verdictLabel(evaluation.verdict, locale) }, locale)
    + (briefQualifiesAcceptance(task, evaluation.verdict) ? ` · ${acceptanceEvidenceQualifier(task!.criteria.map(row => row.evaluator), locale)}` : '')
    + (evaluation.reason ? ` · ${notAcceptedLabel(evaluation.reason, locale)}` : '');
}
/** The worker's own final report as claim lines (worker detail, run inspect and the transcript view; F2-6: never the raw JSON in human text). */
export function reportClaimLines(report: WorkerFinalReport, openIssues: readonly string[] | null | undefined, locale: Locale): string[] {
  const checks = { passed: t('monitor.human.passed', {}, locale), failed: t('monitor.human.failed', {}, locale),
    'not-run': t('monitor.human.notRun', {}, locale), unknown: t('monitor.human.unknown', {}, locale) }, none = t('monitor.brief.noneReported', {}, locale);
  return [t('monitor.brief.claim', { value: safe(report.summary) }, locale), t('monitor.brief.claimFiles', { value: report.changedFiles.map(safe).join(', ') || none }, locale),
    ...report.checks.map(check => t('monitor.brief.claimCheck', { command: safe(check.command), outcome: checks[check.outcome] }, locale)),
    t('monitor.brief.openIssues', { value: openIssues?.map(safe).join('; ') || none }, locale)];
}
/** Shared EN/TR wording for worker detail and run inspect. Labels never turn worker reports into evaluation evidence. */
/** `ids` (BeUser M-33) fills the restore command of a set-aside result; without them its placeholders stay. */
export function renderBriefLines(task: TaskBrief | undefined, result: ResultBrief | undefined, locale: Locale, ids?: Readonly<{ scope: string; run: string; task: string }>): string[] {
  const missing = t('monitor.brief.missing', {}, locale);
  const lines: string[] = [];
  if (task) {
    lines.push(t('monitor.brief.task', { value: task.task ? safe(task.task) : missing }, locale),
      t('monitor.brief.scope', { value: task.scopePaths ? task.scopePaths.map(safe).join(', ') : missing }, locale),
      t('monitor.brief.acceptance', { value: task.acceptance ? safe(task.acceptance) : missing }, locale),
      t('monitor.brief.profile', { value: task.profile ? short(`${safe(task.profile.id)}@${task.profile.version}`) : missing }, locale),
      t('monitor.brief.model', { value: task.model ? `${safe(task.model.channelId)}/${safe(task.model.modelId)}` : missing }, locale),
      t('monitor.brief.effort', { value: task.effort ? safe(task.effort) : missing }, locale),
      t('monitor.brief.context', { value: task.contextRefs.length ? task.contextRefs.map(ref => short(`${safe(ref.id)}@${ref.version} (${ref.sha256})`)).join(', ') : missing }, locale));
    // S4B-5: the memory part frozen at admission (only when one was sent), recognised by the id admission gives it (a template's own part could share the prefix).
    const memory = task.contextRefs.filter(ref => MEMORY_PART.test(ref.id));
    if (memory.length) lines.push(t('inspect.context.memory', { value: memory.map(ref => short(`${safe(ref.id)}@${ref.version} (${ref.sha256})`)).join(', ') }, locale));
    for (const criterion of task.criteria) lines.push(t('monitor.brief.criterion', { id: safe(criterion.id), value: safe(criterion.description), evaluator: `${safe(criterion.evaluator.id)}@${criterion.evaluator.version}` }, locale));
  }
  if (result) {
    lines.push(evaluationText(task, result.evaluation, locale));
    const report = result.report?.status === 'reported' ? result.report.report : null;
    if (report) lines.push(...reportClaimLines(report, result.openIssues, locale));
    else {
      lines.push(t('monitor.human.reportMissing', {}, locale), t('monitor.brief.openIssues', { value: missing }, locale));
    }
    const receipts = result.runDelivery?.receipts ?? (result.runDelivery ? [result.runDelivery] : []);
    for (const receipt of receipts) lines.push(t('monitor.brief.runReceipt', { state: deliveryLabel(receipt.state, locale), command: receipt.commandId ? short(safe(receipt.commandId)) : missing,
      target: receipt.targetRef ? short(safe(receipt.targetRef)) : missing, commit: receipt.commit ? short(receipt.commit) : missing }, locale));
    if (result.failedTests) {
      lines.push(t('monitor.brief.failedTests', { count: result.failedTests.count, shown: result.failedTests.names.length, names: result.failedTests.names.map(safe).join('; ') }, locale));
      if (result.failedTests.count > result.failedTests.names.length) lines.push(t('monitor.brief.failedTestsMore', { more: result.failedTests.count - result.failedTests.names.length }, locale));
    }
    const outlook = result.deliveryOutlook === 'none' ? t('monitor.brief.deliveryNone', {}, locale) : result.deliveryOutlook === 'patch-not-prepared' ? t('monitor.brief.deliveryPatchNotPrepared', {}, locale)
      : result.deliveryOutlook === 'awaiting-delivery' && result.setAside ? t('monitor.brief.deliverySetAside', ids ? { scope: safe(ids.scope), run: safe(ids.run), task: safe(ids.task) } : { scope: '<scope>', run: '<run>', task: '<task>' }, locale)
      : result.deliveryOutlook === 'awaiting-delivery' ? t('monitor.brief.deliveryAwaiting', {}, locale) : null;
    if (result.dismissalUnread && !receipts.length) lines.push(t('monitor.brief.dismissalUnread', { code: result.dismissalUnread }, locale));
    lines.push(receipts.length ? t('monitor.brief.attribution', {}, locale) : outlook ?? t('monitor.brief.deliveryMissing', {}, locale));
  }
  return lines;
}
