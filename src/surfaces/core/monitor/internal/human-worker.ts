import { renderBriefLines } from './brief.js';
import { redactSensitive, t, terminalSafeText, type Locale } from '#platform/index.js';
import { resolveWorkerUsage, type MonitorWorker } from '#engine/index.js';
import { span, type MonitorLine } from './layout.js';
import { clockText, verdictLabel } from './labels.js';
const safe = (text: string) => redactSensitive(terminalSafeText(text));
/** Human hierarchy from the shared snapshot. Reports are claims; only the engine's evaluation line states acceptance. */
export function humanWorkerLines(worker: MonitorWorker, locale: Locale): MonitorLine[] {
  const h = worker.human; if (!h) return [];
  const line = (text: string, role?: 'strong' | 'warning' | 'muted'): MonitorLine => [span(text, role)];
  const sources = { title: t('monitor.human.titleShort', {}, locale), task: t('monitor.human.titleTask', {}, locale),
    acceptance: t('monitor.human.titleAcceptance', {}, locale), missing: t('monitor.human.titleMissing', {}, locale) };
  const usage = ['denied', 'unavailable'].includes(h.transcript.state) ? null : resolveWorkerUsage(worker);
  const report = h.finalReport?.status === 'reported' ? h.finalReport.report : null;
  const checks = { passed: t('monitor.human.passed', {}, locale), failed: t('monitor.human.failed', {}, locale),
    'not-run': t('monitor.human.notRun', {}, locale), unknown: t('monitor.human.unknown', {}, locale) };
  const patchMissing = h.patch.state === 'denied' ? t('monitor.human.patchDenied', {}, locale)
    : h.patch.state === 'unavailable' ? t('monitor.human.patchUnavailable', {}, locale) : t('monitor.human.patchMissing', {}, locale);
  const transcriptMissing = h.transcript.state === 'denied' ? t('monitor.human.transcriptDenied', {}, locale)
    : h.transcript.state === 'unavailable' ? t('monitor.human.transcriptUnavailable', {}, locale) : t('monitor.human.transcriptMissing', {}, locale);
  return [
    line(t('monitor.human.title', { title: h.title ? safe(h.title) : t('monitor.human.noTitle', {}, locale), source: sources[h.titleEvidence] }, locale), 'strong'),
    ...renderBriefLines(h.taskBrief, h.resultBrief, locale).map(text => line(text)),
    ...(h.resultBrief ? [] : [line(t('monitor.human.evaluation', { verdict: verdictLabel(h.evaluation, locale) }, locale)
      + (h.evaluationReason ? ` · ${t('task.acceptance.noChangeProduced', {}, locale)}` : ''), h.evaluation === 'rejected' ? 'warning' : undefined)]),
    ...(h.evaluationReason && h.patch.state === 'recorded' && h.patch.fileCount === 0 ? [] : [h.patch.state === 'recorded' ? h.patch.fileCount === 0 ? line(t('monitor.human.emptyPatch', {}, locale), h.evaluation === 'rejected' ? 'warning' : undefined)
      : line(t('monitor.human.patch', { count: h.patch.fileCount ?? '—', files: h.patch.files.map(safe).join(', ') }, locale)) : line(patchMissing, 'muted')]),
    ...(h.patch.truncated ? [line(t('monitor.human.bounded', {}, locale), 'muted')] : []),
    usage ? line(t('monitor.human.usage', { source: worker.usageEvidence === 'sealed' ? t('monitor.human.sealed', {}, locale) : t('monitor.human.live', {}, locale),
      turns: usage.turns ?? '—', input: usage.tokenUsageRecorded === true ? usage.tokens.input : '—', output: usage.tokenUsageRecorded === true ? usage.tokens.output : '—', cost: usage.costUsd === null ? '—' : usage.costUsd.toFixed(4) }, locale))
      : worker.usageEvidence === 'invalid' || worker.usageEvidence === 'unavailable'
        ? line(t('cli.workers.usageRejected', { reason: worker.usageEvidence === 'invalid' ? t('cli.workers.usageEvidence.invalid', {}, locale) : t('cli.workers.usageEvidence.unavailable', {}, locale) }, locale), 'warning')
        : line(t('monitor.human.usageMissing', {}, locale), 'muted'),
    h.startedAtMs === null ? line(t('monitor.human.startMissing', {}, locale), 'muted') : line(t('monitor.human.start', { time: clockText(h.startedAtMs) }, locale), 'muted'),
    h.endedAtMs === null ? line(t('monitor.human.endMissing', {}, locale), 'muted') : line(h.endedAtSource === 'sealed'
      ? t('monitor.human.endSealed', { time: clockText(h.endedAtMs) }, locale) : t('monitor.human.endObserved', { time: clockText(h.endedAtMs) }, locale), 'muted'),
    ...(h.resultBrief ? [] : report ? [line(t('monitor.human.report', { summary: safe(report.summary) }, locale)), ...report.checks.map(check => line(t('monitor.human.check', { command: safe(check.command), outcome: checks[check.outcome] }, locale)))]
      : [line(t('monitor.human.reportMissing', {}, locale), 'muted')]),
    ...(h.transcript.state === 'sealed' ? [line(t('monitor.human.transcript', {}, locale), 'muted'), ...h.transcript.excerpt.map(event => [span(`${event.kind}: ${safe(event.summary)}`)])] : [line(transcriptMissing, 'muted')]),
    ...(h.transcript.truncated ? [line(t('monitor.human.bounded', {}, locale), 'muted')] : []),
    line(t('monitor.human.technical', { task: worker.taskId, attempt: worker.identity?.attemptId ?? '—', generation: worker.identity?.generation ?? '—', sha: h.patch.baseCommit ?? '—' }, locale), 'muted'),
  ];
}
