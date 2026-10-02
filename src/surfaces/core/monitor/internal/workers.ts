import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { WorkerObservation, WorkerObservationQuery, WorkerObservationReport, WorkerObservationSource } from '#engine/index.js';
import type { MonitorCommandContext } from './context.js';
import { renderWorkerModelLine } from './worker-model.js';
export type WorkerObservationHandler = (root: string, query: WorkerObservationQuery, options: ConfigLoadOptions) => Promise<WorkerObservationReport>;
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
export const renderWorkerRow = (w: WorkerObservation, locale: Locale) => { const x = w.terminal, id = w.identity; return t('cli.workers.row', { ref: `${id?.runId ?? '-'}/${w.taskId}`, attempt: id?.attemptId.slice(0, 8) ?? '-', generation: id?.generation ?? '-', process: x ? `${w.process} ${x.exitCode ?? x.signal ?? '-'}` : w.process, heartbeat: renderHeartbeat(w, locale), provider: w.provider || '-' }, locale); };
export const renderWorkerSource = (s: WorkerObservationSource, locale: Locale): string[] => [t('cli.workers.source', { source: s.id, path: s.path, status: s.status }, locale) + (s.truncated ? t('cli.workers.sourceMore', { nextAfter: s.nextAfter ?? '-' }, locale) : ''), ...(s.workers.length ? s.workers.flatMap(w => [renderWorkerRow(w, locale), ...(w.model ? [t('cli.workers.model', { task: w.taskId, line: renderWorkerModelLine(w.model, locale) }, locale)] : [])]) : [t('cli.workers.empty', {}, locale)])];
export async function workersCommand(argv: readonly string[], context: MonitorCommandContext) {
  const values = new Map<string, string>(); let json = false;
  const help = argv.length === 2 && ['--help', '-h'].includes(argv[1]!);
  if (!help && !['list', 'watch'].includes(argv[1] ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--no-color') continue;
    if (!['--scope', '--source', '--after', '--limit', '--project', '--lang', '--samples'].includes(flag) || values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(flag, value);
  }
  const locale = resolveLocale(values.get('--lang'), context.env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}) };
  if (help) { emit(t('cli.workers.help', {}, locale), sinks); return; }
  const scopeId = values.get('--scope'); if (!scopeId || !context.inspectWorkers) throw ErrorRegistry.createError('CLI_USAGE');
  const number = (flag: string) => { const v = values.get(flag); if (v === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v))) throw ErrorRegistry.createError('CLI_USAGE'); return Number(v); };
  const limit = number('--limit'), samples = number('--samples');
  if (argv[1] !== 'watch' && samples !== undefined) throw ErrorRegistry.createError('CLI_USAGE');
  const root = resolve(context.root ?? process.cwd(), values.get('--project') ?? '.'); const options = { env: context.env ?? process.env };
  const config = await loadConfig(root, { ...options, heal: false }); let count = 0;
  const query = { schemaVersion: 1 as const, scopeId, ...(values.has('--source') ? { source: values.get('--source')! } : {}),
    after: values.get('--after') ?? null, ...(limit === undefined ? {} : { limit }) };
  do {
    if (context.signal?.aborted) return;
    const result = await context.inspectWorkers(root, query, options);
    emit(result, { ...sinks, json, render: report => [t('cli.workers.heading', { time: new Date(report.observedAt).toISOString() }, locale),
      ...report.sources.flatMap(source => renderWorkerSource(source, locale)), t('cli.workers.notice', {}, locale)].join('\n') });
    if (argv[1] !== 'watch' || (samples !== undefined && ++count >= samples)) return;
    try { await wait(config.inspection.workers.heartbeatMs, undefined, { signal: context.signal }); } catch { if (context.signal?.aborted) return; throw ErrorRegistry.createError('WORKER_OBSERVATION_UNAVAILABLE'); }
  } while (!context.signal?.aborted);
}
