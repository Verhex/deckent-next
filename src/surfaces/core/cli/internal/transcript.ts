import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { AttemptIdentity, WorkerEvent, WorkerEventSummary, WorkerPhase } from '#domain/index.js';
export type WorkerTranscriptHandler = (root: string, identity: AttemptIdentity, options: ConfigLoadOptions) => Promise<Readonly<{
  schemaVersion: 1; identity: AttemptIdentity; sealed: Readonly<{ eventCount: number; sealedAt: number }> | null;
  summary: WorkerEventSummary | null; events: readonly WorkerEvent[] }>>;
const seconds = (ms: number | null) => ms === null ? '—' : (ms / 1000).toFixed(1);
export function phaseLabel(phase: WorkerPhase, locale: Locale) {
  const labels: Record<WorkerPhase, string> = {
    starting: t('cli.worker.phase.starting', {}, locale), thinking: t('cli.worker.phase.thinking', {}, locale), reading: t('cli.worker.phase.reading', {}, locale),
    editing: t('cli.worker.phase.editing', {}, locale), running: t('cli.worker.phase.running', {}, locale), searching: t('cli.worker.phase.searching', {}, locale),
    fetching: t('cli.worker.phase.fetching', {}, locale), delegating: t('cli.worker.phase.delegating', {}, locale), finished: t('cli.worker.phase.finished', {}, locale),
    failed: t('cli.worker.phase.failed', {}, locale) };
  return labels[phase];
}
const TOOL_PHASE: Record<string, WorkerPhase> = { read: 'reading', edit: 'editing', write: 'editing', shell: 'running', search: 'searching', network: 'fetching', agent: 'delegating', other: 'running' };
/** Human-readable transcript: header, usage and a step timeline. Worker-reported evidence, not acceptance. */
export function renderWorkerTranscript(data: Awaited<ReturnType<WorkerTranscriptHandler>>, locale: Locale): string {
  if (!data.sealed || !data.summary) return t('cli.task.transcript.none', {}, locale);
  const s = data.summary;
  const lines = [
    t('cli.task.transcript.header', { provider: s.provider ?? '—', model: s.model ?? '—', turns: s.turns ?? '—', seconds: seconds(s.durationMs),
      api: seconds(s.apiDurationMs), outcome: s.outcome }, locale),
    t('cli.task.transcript.tokens', { input: s.tokens.input, output: s.tokens.output, cacheRead: s.tokens.cacheRead, cacheWrite: s.tokens.cacheWrite,
      ratio: s.cacheReadRatio === null ? '—' : `${Math.round(s.cacheReadRatio * 100)}%`, cost: s.costUsd === null ? '—' : s.costUsd.toFixed(4),
      basis: s.costBasis ?? '—' }, locale),
    t('cli.task.transcript.tools', { calls: Object.entries(s.toolCalls).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(' · ') || '—',
      errors: s.toolErrors, files: s.filesTouched.join(', ') || '—' }, locale),
  ];
  for (const event of data.events) {
    const at = `+${seconds(event.atMs)}s`.padStart(8);
    if (event.kind === 'session.started') lines.push(`${at}  ${phaseLabel('starting', locale)}  ${event.model ?? ''}`);
    else if (event.kind === 'tool.call') lines.push(`${at}  ${phaseLabel(TOOL_PHASE[event.toolClass] ?? 'running', locale)}  ${[event.target, event.detail].filter(Boolean).join(' — ')}`);
    else if (event.kind === 'tool.result' && event.status === 'error') lines.push(`${at}  ${t('cli.task.transcript.toolError', { tool: event.toolId }, locale)}`);
    else if (event.kind === 'message' && !event.thinking && event.excerpt) lines.push(`${at}  ${phaseLabel('thinking', locale)}  ${event.excerpt}`);
    else if (event.kind === 'limit') lines.push(`${at}  ${t('cli.task.transcript.limit', { limit: event.limit }, locale)}`);
    else if (event.kind === 'session.ended') lines.push(`${at}  ${phaseLabel(event.outcome === 'success' ? 'finished' : 'failed', locale)}`);
  }
  lines.push(t('cli.task.transcript.notice', {}, locale));
  return lines.join('\n');
}
