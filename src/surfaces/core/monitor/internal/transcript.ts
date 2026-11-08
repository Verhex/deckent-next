import { t, terminalSafeText, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { AttemptIdentity, WorkerEvent, WorkerEventSummary, WorkerPhase, WorkerFinalReportResult, WorkerModelView, WorkerToolClass } from '#domain/index.js';
import { quotaWaitText } from './labels.js';
import { reportClaimLines } from './brief.js';
import { renderWorkerModelLine } from './worker-model.js';
export type WorkerTranscriptHandler = (root: string, identity: AttemptIdentity, options: ConfigLoadOptions) => Promise<Readonly<{
  schemaVersion: 1 | 2; identity: AttemptIdentity; finalReport?: WorkerFinalReportResult; sealed: Readonly<{ eventCount: number; sealedAt: number; projection?: 'complete' | 'partial' }> | null;
  summary: WorkerEventSummary | null; events: readonly WorkerEvent[]; model?: WorkerModelView | null }>>;
export const seconds = (ms: number | null) => ms === null ? '—' : (ms / 1000).toFixed(1);
export function phaseLabel(phase: WorkerPhase, locale: Locale) {
  const labels: Record<WorkerPhase, string> = {
    starting: t('cli.worker.phase.starting', {}, locale), thinking: t('cli.worker.phase.thinking', {}, locale), reading: t('cli.worker.phase.reading', {}, locale),
    editing: t('cli.worker.phase.editing', {}, locale), running: t('cli.worker.phase.running', {}, locale), searching: t('cli.worker.phase.searching', {}, locale),
    fetching: t('cli.worker.phase.fetching', {}, locale), delegating: t('cli.worker.phase.delegating', {}, locale), finished: t('cli.worker.phase.finished', {}, locale),
    failed: t('cli.worker.phase.failed', {}, locale) };
  return labels[phase];
}
const TOOL_PHASE: Record<string, WorkerPhase> = { read: 'reading', edit: 'editing', write: 'editing', shell: 'running', search: 'searching', network: 'fetching', agent: 'delegating', other: 'running' };
/** F2-6: the tool classes of the usage line in words (the summary counts them by class). */
function toolClassLabel(toolClass: WorkerToolClass, locale: Locale): string {
  const labels: Record<WorkerToolClass, string> = { read: t('cli.task.transcript.class.read', {}, locale), edit: t('cli.task.transcript.class.edit', {}, locale),
    write: t('cli.task.transcript.class.write', {}, locale), shell: t('cli.task.transcript.class.shell', {}, locale), search: t('cli.task.transcript.class.search', {}, locale),
    network: t('cli.task.transcript.class.network', {}, locale), agent: t('cli.task.transcript.class.agent', {}, locale), other: t('cli.task.transcript.class.other', {}, locale) };
  return labels[toolClass];
}
/** The worker's final report in words; its JSON stays behind `deckent task transcript --json` (F2-6). */
function reportLines(report: WorkerFinalReportResult, locale: Locale): string[] {
  return report.status === 'reported' ? reportClaimLines(report.report, report.report.openIssues, locale) : [t('monitor.human.reportMissing', {}, locale)];
}
/** A worker's text message that is its JSON final report (the last message) is named, not printed raw (F2-7). */
const JSON_MESSAGE = /^\s*(?:```(?:json)?\s*)?[{[]/u;
/**
 * Human-readable transcript: header, usage and a step timeline. Worker-reported evidence, not acceptance. A pinned native worker
 * (`model` present: a `nativeSubscription` profile) runs on the person's subscription, so its view carries no price (owner F2-8).
 */
export function renderWorkerTranscript(data: Awaited<ReturnType<WorkerTranscriptHandler>>, locale: Locale): string {
  // WORKER-CURRENCY-2 report view: the pinned model row first, with the evidence limit stated.
  const model = data.model ? [renderWorkerModelLine(data.model, locale), t('cli.worker.model.notice', {}, locale)] : [];
  // Event excerpts, targets, models and the report are worker-written (untrusted): the whole view leaves through the terminal sanitizer.
  if (!data.sealed || !data.summary) return terminalSafeText([...model, t('cli.task.transcript.none', {}, locale),
    ...(data.finalReport ? [t('cli.task.transcript.notice', {}, locale), ...reportLines(data.finalReport, locale)] : [])].join('\n'));
  const s = data.summary, subscription = Boolean(data.model);
  const reported = data.finalReport?.status === 'reported' ? data.finalReport.report.changedFiles : [];
  const lines = [...model,
    t('cli.task.transcript.header', { provider: s.provider ?? '—', model: s.model ?? '—', turns: s.turns ?? '—', seconds: seconds(s.durationMs),
      api: seconds(s.apiDurationMs), outcome: s.outcome }, locale),
    t('cli.task.transcript.tokens', { input: s.tokens.input, output: s.tokens.output, cacheRead: s.tokens.cacheRead, cacheWrite: s.tokens.cacheWrite,
      ratio: s.cacheReadRatio === null ? '—' : `${Math.round(s.cacheReadRatio * 100)}%` }, locale),
    ...(subscription || s.costUsd === null ? [] : [t('cli.task.transcript.cost', { cost: s.costUsd.toFixed(4), basis: s.costBasis ?? '—' }, locale)]),
    t('cli.task.transcript.tools', { calls: (Object.entries(s.toolCalls) as [WorkerToolClass, number][]).filter(([, n]) => n > 0).map(([k, n]) => `${toolClassLabel(k, locale)} ${n}`).join(' · ') || '—',
      errors: s.toolErrors, files: s.filesTouched.join(', ') || '—' }, locale),
    // F2-7: files the tools did not name but the report claims are said apart, as the worker's claim.
    ...(!s.filesTouched.length && reported.length ? [t('cli.task.transcript.reportedFiles', { files: reported.join(', ') }, locale)] : []),
  ];
  for (const event of data.events) {
    const at = `+${seconds(event.atMs)}s`.padStart(8);
    if (event.kind === 'session.started') lines.push(`${at}  ${phaseLabel('starting', locale)}  ${event.model ?? ''}`);
    else if (event.kind === 'tool.call') lines.push(`${at}  ${phaseLabel(TOOL_PHASE[event.toolClass] ?? 'running', locale)}  ${[event.target, event.detail].filter(Boolean).join(' — ') || event.name}`);
    else if (event.kind === 'tool.result' && event.status === 'error') lines.push(`${at}  ${t('cli.task.transcript.toolError', { tool: event.toolId }, locale)}`);
    else if (event.kind === 'message' && !event.thinking && event.excerpt) lines.push(`${at}  ${JSON_MESSAGE.test(event.excerpt) ? t('cli.task.transcript.reportMessage', {}, locale) : `${t('cli.task.transcript.message', {}, locale)}  ${event.excerpt}`}`);
    else if (event.kind === 'limit') lines.push(`${at}  ${t('cli.task.transcript.limit', { limit: event.limit }, locale)}`);
    else if (event.kind === 'quota-exhausted') lines.push(`${at}  ${event.resetsAtMs === null ? t('run.quota.unknown', {}, locale) : quotaWaitText(event.resetsAtMs, true, locale)}`);
    else if (event.kind === 'session.ended') lines.push(`${at}  ${phaseLabel(event.outcome === 'success' ? 'finished' : 'failed', locale)}`);
  }
  if (data.sealed?.projection === 'partial') lines.push(t('cli.task.transcript.projectionPartial', {}, locale));
  lines.push(t('cli.task.transcript.notice', {}, locale));
  if (data.finalReport) lines.push(...reportLines(data.finalReport, locale));
  return terminalSafeText(lines.join('\n'));
}
