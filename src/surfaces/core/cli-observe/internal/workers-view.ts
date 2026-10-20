import { t, type Locale } from '#platform/index.js';
import { resolveWorkerUsage, workerFinished, type WorkerObservation, type WorkerObservationReport, type WorkerProcessState } from '#engine/index.js';
import { displayId, formatAgo, formatBytes, formatDecimal, formatDuration, orderPendingFirst, renderCliTable, type CliTableStyle } from '#surfaces/core/cli-human/index.js';

/** What a person needs to know about one worker: running now, finished (history), lost (no process and no result) or unknown (not verifiable). */
export type WorkerKind = 'active' | 'finished' | 'lost' | 'unknown';
// Exhaustive over the engine's process states (a new state fails the typecheck here instead of silently reading as running).
const PROCESS_KIND: Readonly<Record<WorkerProcessState, WorkerKind>> = { running: 'active', paused: 'active', created: 'active', exited: 'finished',
  missing: 'lost', 'absent-unverified': 'lost', unknown: 'unknown', 'present-unverified': 'unknown', denied: 'unknown' };

/** A worker with a recorded end (terminal result) or released custody is history; otherwise its observed process decides. */
export function workerKind(worker: WorkerObservation): WorkerKind {
  return workerFinished(worker) ? 'finished' : PROCESS_KIND[worker.process];
}

/** The newest instant this worker was heard from: its heartbeat, else its last resource sample, else its last reported event. */
export function lastSignalAt(worker: WorkerObservation, observedAt: number): number | null {
  const heartbeat = worker.files?.heartbeat;
  if (heartbeat && heartbeat.ageMs !== null) return observedAt - heartbeat.ageMs;
  return worker.resources?.latest?.observedAtMs ?? worker.files?.activity?.receivedAt ?? null;
}

export interface WorkersViewInput {
  readonly report: WorkerObservationReport; readonly scopeLine: string; readonly all: boolean; readonly sinceMs: number | null;
  readonly style: CliTableStyle; readonly locale: Locale;
}

function stateWord(worker: WorkerObservation, kind: WorkerKind, locale: Locale): string {
  if (kind === 'finished') return worker.terminal && worker.terminal.exitCode !== 0 && worker.terminal.exitCode !== null
    ? t('cli.workers.state.failed', {}, locale) : t('cli.workers.state.finished', {}, locale);
  if (kind === 'lost') return t('cli.workers.state.lost', {}, locale);
  if (kind === 'unknown') return t('cli.workers.state.unknown', {}, locale);
  const word = worker.process === 'paused' ? t('cli.workers.state.paused', {}, locale) : worker.process === 'created' ? t('cli.workers.state.starting', {}, locale)
    : t('cli.workers.state.running', {}, locale);
  return worker.files?.heartbeat.freshness === 'stale' ? t('cli.workers.state.quiet', { state: word }, locale) : word;
}

/**
 * `deckent workers` for a person (CLI review 2026-10-19 §workers): a summary line, then one row per worker (task · state · model · duration ·
 * CPU · memory · last signal), workers that need a person first; history only with `--all` or `--since`. A lost or unverifiable worker gets
 * the command to look at it. Every worker-reported value (model, ids) reaches the terminal through the table's safe cells (SEC-5S F37).
 */
export function renderWorkersView(input: WorkersViewInput): string {
  const { report, locale } = input, now = report.observedAt;
  const workers = report.sources.flatMap(source => source.workers);
  const kinds = new Map(workers.map(worker => [worker, workerKind(worker)]));
  const count = (kind: WorkerKind) => workers.filter(worker => kinds.get(worker) === kind).length;
  const attention = count('lost') + count('unknown');
  const lines = [t('cli.workers.summary', { scope: input.scopeLine, active: count('active'), attention, history: count('finished') }, locale)];
  for (const source of report.sources) {
    if (source.status !== 'available') lines.push(t('cli.workers.sourceDown', { source: source.id, status: source.status === 'denied' ? t('cli.workers.source.denied', {}, locale)
      : source.status === 'not-sampled' ? t('cli.workers.source.notSampled', {}, locale) : t('cli.workers.source.unavailable', {}, locale) }, locale));
    if (source.truncated) lines.push(t('cli.workers.more', { source: source.id, after: source.nextAfter ?? '-' }, locale));
  }
  const shown = orderPendingFirst(workers.filter(worker => {
    if (!input.all && input.sinceMs === null) return kinds.get(worker) !== 'finished';
    if (input.sinceMs === null) return true;
    const at = lastSignalAt(worker, now);
    return kinds.get(worker) !== 'finished' || (at !== null && at >= now - input.sinceMs);
  }), { pending: worker => kinds.get(worker) !== 'finished', time: worker => lastSignalAt(worker, now) });
  if (!shown.length) {
    lines.push('', t('cli.workers.noneActive', {}, locale));
    if (!input.all && count('finished')) lines.push(t('cli.workers.historyHint', {}, locale));
  } else {
    const taskIds = workers.map(worker => worker.taskId), runIds = workers.map(worker => worker.identity?.runId ?? '');
    const rows = shown.map(worker => {
      const usage = resolveWorkerUsage(worker), sample = worker.resources?.latest ?? null;
      return [displayId(worker.taskId, taskIds), worker.identity ? displayId(worker.identity.runId, runIds) : '-', stateWord(worker, kinds.get(worker)!, locale),
        worker.model?.requested.modelId ?? (worker.provider || '-'), usage?.durationMs === null || usage?.durationMs === undefined ? '-' : formatDuration(usage.durationMs, locale),
        sample?.cpuCores === null || sample?.cpuCores === undefined ? '-' : formatDecimal(sample.cpuCores, locale),
        formatBytes(sample?.memoryBytes ?? worker.resources?.sampledPeakBytes ?? null, locale), formatAgo(lastSignalAt(worker, now), now, locale)];
    });
    lines.push('', renderCliTable([{ header: t('cli.workers.column.task', {}, locale) }, { header: t('cli.workers.column.run', {}, locale) },
      { header: t('cli.workers.column.state', {}, locale) }, { header: t('cli.workers.column.model', {}, locale), shrink: true },
      { header: t('cli.workers.column.duration', {}, locale), align: 'right' }, { header: t('cli.workers.column.cpu', {}, locale), align: 'right' },
      { header: t('cli.workers.column.memory', {}, locale), align: 'right' }, { header: t('cli.workers.column.signal', {}, locale) }], rows, input.style));
    const scope = report.scopeId;
    for (const worker of shown) {
      const kind = kinds.get(worker), run = worker.identity?.runId;
      if (kind === 'lost') lines.push(t('cli.workers.action.lost', { task: displayId(worker.taskId, taskIds),
        step: run ? `deckent run inspect --scope ${scope} --run ${run}` : 'deckent workers --verbose' }, locale));
      else if (kind === 'unknown') lines.push(t('cli.workers.action.unknown', { task: displayId(worker.taskId, taskIds) }, locale));
    }
  }
  lines.push('', t('cli.workers.monitorHint', {}, locale), t('cli.workers.notice', {}, locale));
  return lines.join('\n');
}
