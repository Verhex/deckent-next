import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ErrorRegistry, emit, loadConfig, t, terminalSafeText, type Locale } from '#platform/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { askCliCard, cliMode, cliTableStyle, formatClock, formatDuration, formatKnown, formatUsd, resolveCommandScope, scopeLister, scopeNotice, type CliCardRequest } from '#surfaces/core/cli-human/index.js';
import { renderWorkersView, sourceStatusText } from './workers-view.js';
import { resolveWorkerUsage, workerFinished, type WorkerObservation, type WorkerObservationSource } from '#engine/index.js';
import { processExitText, renderWorkerModelLine, renderResourceDetail, type MonitorCommandContext } from '#surfaces/core/monitor/index.js';
function renderHeartbeat(w: WorkerObservation, locale: Locale): string {
  const h = w.files?.heartbeat;
  const absent = w.diagnostics.includes('output-denied') ? 'denied' : w.diagnostics.includes('custody-released') ? 'released'
    : w.diagnostics.includes('info:ledger-only') ? 'ledger-only' : 'unavailable';
  const label = h ? (h.state === 'available' ? h.freshness : h.state) : absent;
  switch (label) {
    case 'fresh': return t('cli.workers.heartbeat.fresh', {}, locale);
    case 'stale': return t('cli.workers.heartbeat.stale', {}, locale);
    case 'future': return t('cli.workers.heartbeat.future', {}, locale);
    case 'unknown': return t('cli.workers.heartbeat.unknown', {}, locale);
    case 'missing': return t('cli.workers.heartbeat.missing', {}, locale);
    case 'identity-mismatch': return t('cli.workers.heartbeat.identity-mismatch', {}, locale);
    case 'malformed': return t('cli.workers.heartbeat.malformed', {}, locale);
    case 'unavailable': return t('cli.workers.heartbeat.unavailable', {}, locale);
    case 'too-large': return t('cli.workers.heartbeat.too-large', {}, locale);
    case 'denied': return t('cli.workers.heartbeat.denied', {}, locale);
    case 'released': return t('cli.workers.heartbeat.released', {}, locale);
    case 'ledger-only': return t('cli.workers.heartbeat.ledger-only', {}, locale);
    default: return t('cli.workers.heartbeat.state', { state: label }, locale);
  }
}
export const renderWorkerRow = (w: WorkerObservation, locale: Locale) => { const x = w.terminal, id = w.identity; return t('cli.workers.row', { ref: `${id?.runId ?? '-'}/${w.taskId}`, attempt: id?.attemptId.slice(0, 8) ?? '-', generation: id?.generation ?? '-', process: processExitText(w.process, x, locale), heartbeat: renderHeartbeat(w, locale), provider: formatKnown(w.provider, locale) }, locale); };
// PRE-34: `running` in a usage summary only means no session end was reported; a finished worker says so instead of "still running".
export const renderWorkerUsage = (u: NonNullable<WorkerObservation['usage']>, locale: Locale, finished = false) => {
  const outcomes = { success: t('monitor.human.usageOutcomeSuccess', {}, locale), error: t('monitor.human.usageOutcomeError', {}, locale), limit: t('monitor.human.usageOutcomeLimit', {}, locale),
    running: finished ? t('monitor.human.usageOutcomeUnreported', {}, locale) : t('monitor.human.usageOutcomeRunning', {}, locale) };
  const d = (v: number | null | undefined) => v === null || v === undefined ? '-' : String(v); return t('cli.workers.usage', { turns: d(u.turns), duration: u.durationMs === null || u.durationMs === undefined ? '-' : formatDuration(u.durationMs, locale), input: u.tokenUsageRecorded === true ? d(u.tokens?.input) : '-', output: u.tokenUsageRecorded === true ? d(u.tokens?.output) : '-', cost: u.costUsd === null || u.costUsd === undefined ? '-' : formatUsd(u.costUsd, locale), outcome: u.outcome ? outcomes[u.outcome] : '-' }, locale); };
const renderUsage = (worker: WorkerObservation, locale: Locale): string[] => {
  const usage = resolveWorkerUsage(worker);
  if (worker.usageEvidence === 'invalid' || worker.usageEvidence === 'unavailable') return [t('cli.workers.usageRejected', { reason: worker.usageEvidence === 'invalid' ? t('cli.workers.usageEvidence.invalid', {}, locale) : t('cli.workers.usageEvidence.unavailable', {}, locale) }, locale)];
  return [...renderResourceDetail(worker.resources, locale), ...(usage ? [renderWorkerUsage(usage, locale, workerFinished(worker))] : [])];
};
/** `nextPage` (PRE-5): the exact command that reads the source's next page; a truncated source names it instead of a bare cursor. */
export const renderWorkerSource = (s: WorkerObservationSource, locale: Locale, nextPage?: (source: string, after: string) => string): string[] => [
  t('cli.workers.source', { source: s.id, path: s.path, status: sourceStatusText(s.status, locale) }, locale)
    + (s.truncated ? t('cli.workers.sourceMore', { command: nextPage && s.nextAfter ? nextPage(s.id, s.nextAfter) : '-' }, locale) : ''),
  ...(s.workers.length ? s.workers.flatMap(w => [renderWorkerRow(w, locale), ...(w.model ? [t('cli.workers.model', { task: w.taskId, line: renderWorkerModelLine(w.model, locale) }, locale)] : []), ...renderUsage(w, locale)])
    : [t('cli.workers.empty', {}, locale)])];
/** `12h`, `30m`, `2d`, `45s`: a history window for `--since`. */
function sinceMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^([1-9][0-9]{0,5})([smhd])$/.exec(value);
  if (!match) throw ErrorRegistry.createError('CLI_USAGE');
  return Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
}
const VALUE_FLAGS = ['--scope', '--source', '--after', '--limit', '--project', '--lang', '--samples', '--since'];
const SWITCHES = ['--json', '--all', '--verbose'];
/** Clears the live window before each frame on a person's terminal (never in a pipe, so a pipe keeps every frame as plain lines). */
const CLEAR = '\u001b[H\u001b[2J';

/**
 * `deckent workers [list|watch]`: bare = `list` in the default scope (a read: `--scope`, else the configured scope, else a TTY pick, else
 * CLI_SCOPE_REQUIRED naming the scopes). The person's view lists workers that are running or need attention, with a summary first; history
 * with `--all`/`--since`; the full per-source detail with `--verbose`; the unchanged observation report with `--json`. `watch` redraws one
 * bounded window on a terminal (Esc or q ends it) and prints frames in a pipe; `--samples` bounds it everywhere.
 */
export async function workersCommand(argv: readonly string[], context: MonitorCommandContext) {
  const named = argv[1] !== undefined && !argv[1].startsWith('-'), action = named ? argv[1]! : 'list';
  const values = new Map<string, string>(), switches = new Set<string>();
  const help = argv.length === 2 && ['--help', '-h'].includes(argv[1]!);
  if (!help && !['list', 'watch'].includes(action)) throw ErrorRegistry.createError('CLI_USAGE');
  for (let i = named ? 2 : 1; i < argv.length && !help; i++) {
    const flag = argv[i]!;
    if (flag === '--no-color') continue;
    if (SWITCHES.includes(flag) && !switches.has(flag)) { switches.add(flag); continue; }
    if (!VALUE_FLAGS.includes(flag) || values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(flag, value);
  }
  const json = switches.has('--json');
  const locale = commandLocale(context, values.get('--lang'));
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}) };
  if (help) { emit(t('cli.workers.help', {}, locale), sinks); return; }
  if (!context.inspectWorkers) throw ErrorRegistry.createError('CLI_USAGE');
  const number = (flag: string) => { const v = values.get(flag); if (v === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v))) throw ErrorRegistry.createError('CLI_USAGE'); return Number(v); };
  const limit = number('--limit'), samples = number('--samples'), since = sinceMs(values.get('--since'));
  if (action !== 'watch' && samples !== undefined) throw ErrorRegistry.createError('CLI_USAGE');
  const root = resolve(context.root ?? process.cwd(), values.get('--project') ?? '.'); const options = { env: context.env ?? process.env };
  const config = await loadConfig(root, { ...options, heal: false }); let count = 0;
  const mode = cliMode(context, json), configured = (config.terminal as { scopeId?: string } | undefined)?.scopeId;
  const ask = (request: CliCardRequest) => askCliCard(request, { locale, ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}),
    env: options.env, ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}), ...(context.signal ? { signal: context.signal } : {}) });
  const scope = await resolveCommandScope({ command: 'deckent workers', locale, explicit: values.get('--scope'), configured, mutating: false,
    interactive: mode.mode === 'interactive', listScopes: scopeLister(context, root, options), pick: ask });
  if (!scope) return;
  const query = { schemaVersion: 1 as const, scopeId: scope.scopeId, ...(values.has('--source') ? { source: values.get('--source')! } : {}),
    after: values.get('--after') ?? null, ...(limit === undefined ? {} : { limit }) };
  const live = action === 'watch' && mode.mode === 'interactive', style = cliTableStyle(context);
  // PRE-5: the next page is a command the person can run as is: the same scope, view and bounds, one source, after its cursor.
  const nextPage = (source: string, after: string) => ['deckent workers', '--scope', scope.scopeId, '--source', source, '--after', after,
    ...(['--limit', '--since', '--project'] as const).flatMap(flag => values.has(flag) ? [flag, values.get(flag)!] : []),
    ...(['--all', '--verbose'] as const).filter(flag => switches.has(flag))].join(' ');
  const stop = new AbortController(), signal = context.signal ? AbortSignal.any([context.signal, stop.signal]) : stop.signal;
  const release = live ? listenForExit(context.stdin ?? process.stdin, () => stop.abort()) : () => undefined;
  try {
    do {
      if (signal.aborted) return;
      const result = await context.inspectWorkers(root, query, options).catch(async (error: unknown) => {
        // The refusal keeps its code (SCOPE_UNKNOWN, company-aware authorization); a person also gets the scopes they can read (`--json`
        // keeps one typed error object on stderr).
        if (!json && (error as { code?: unknown }).code === 'SCOPE_UNKNOWN') {
          const scopes = await scopeLister(context, root, options)().catch(() => []);
          emit(t('cli.workers.validScopes', { scope: terminalSafeText(scope.scopeId), scopes: scopes.map(item => terminalSafeText(item)).join(', ') || '-' }, locale),
            { level: 'warning', ...(context.stderr ? { stderr: context.stderr } : {}) });
        }
        throw error;
      });
      // SEC-5S F37: model names, provider and paths are worker-reported; the human view reaches the terminal only safe.
      emit(result, { ...sinks, json, render: report => (live ? CLEAR : '') + terminalSafeText(switches.has('--verbose')
        ? [t('cli.workers.heading', { time: formatClock(report.observedAt, locale) }, locale), ...report.sources.flatMap(source => renderWorkerSource(source, locale, nextPage)), t('cli.workers.notice', {}, locale)].join('\n')
        : renderWorkersView({ report, scopeLine: scopeNotice(scope, locale), all: switches.has('--all'), sinceMs: since, style, locale, nextPage })
          + (live ? '\n' + t('cli.workers.watchHint', {}, locale) : '')) });
      if (action !== 'watch' || (samples !== undefined && ++count >= samples)) return;
      try { await wait(config.inspection.workers.heartbeatMs, undefined, { signal }); } catch { if (signal.aborted) return; throw ErrorRegistry.createError('WORKER_OBSERVATION_UNAVAILABLE'); }
    } while (!signal.aborted);
  } finally { release(); }
}

/** Esc, q or Ctrl+C ends the live window (raw mode turns Ctrl+C into a key); the terminal mode is restored on every exit path. */
function listenForExit(stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown }, exit: () => void): () => void {
  if (typeof stdin.setRawMode !== 'function') return () => undefined;
  const onData = (chunk: Buffer | string) => { const key = String(chunk); if (key === '\u001b' || key === 'q' || key === '\u0003') exit(); };
  stdin.setRawMode(true); stdin.on('data', onData); stdin.resume();
  return () => { stdin.off('data', onData); stdin.setRawMode!(false); stdin.pause(); };
}
