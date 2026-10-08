import type { RunView } from '#engine/index.js';
import { shortId } from '#platform/index.js';
import { loadRunViewsForWatch, ledgerEntriesForWorkers, fillTemplate, type WorklineLedgerPorts, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { ArrowPicker, ARROW_PICKER_ROWS } from '#surfaces/core/terminal-picker/index.js';
import { projectHumanPickerText, span, useHumanTextSecrets, type Span } from '#surfaces/core/terminal-render/index.js';
import { Window, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { liveWindowLines } from './live-windows.js';
import type { LocalExecution, WorklinePanel } from './workline-panel.js';
import type { WorkSurfaceLabels } from './workline-actions.js';

export interface JobWindowLabels {
  readonly hints: string; readonly watchStatus: string; readonly push: string; readonly poll: string;
  readonly cancelPickerTitle: string; readonly system: string; readonly runTitle: string; readonly runFallback: string; readonly transcriptTitle: string;
  readonly state: string; readonly tasks: string; readonly attempts: string; readonly delivery: string; readonly unknown: string;
  readonly clearSession: string; readonly clearDetail: string; readonly kept: string; readonly closed: string;
  /** I-5: the opening line when work is running: `{runs}`, `{workers}`. */
  readonly opening: string;
  readonly runStates: Readonly<Record<string, string>>;
}
export type JobWindowPresentation = Readonly<{ kind: 'job-window'; title: string; lines: readonly WindowLine[] }>
  | Readonly<{ kind: 'job-picker'; title: string; rows: readonly (readonly Span[])[] }>;

/** Only projections, not hashes or command text, provide a run's human title. */
function displayId(value: string): string { return value.length > 12 ? shortId(value).slice(0, 8) : value; }

export function runTitle(run: RunView, labels: JobWindowLabels): string {
  return run.tasks.find(task => task.taskBrief?.task)?.taskBrief?.task ?? labels.runFallback;
}
export function runStateText(run: RunView, labels: JobWindowLabels): string {
  const value = run.state?.kind === 'terminal' ? run.state.outcome : run.state?.kind ?? 'unknown';
  return labels.runStates[value] ?? labels.unknown;
}
/**
 * SLASH-WINDOWS I-5 (owner 2026-10-08, Jev 59f75361): the one opening system line when the start snapshot shows running work — runs that
 * are not finished and workers still active — or null when nothing runs (then nothing is printed; the status row keeps the approval count).
 */
export function openingWorkText(runs: readonly RunView[] | undefined, activeWorkers: number, labels: JobWindowLabels): string | null {
  const running = (runs ?? []).filter(run => run.state?.kind !== 'terminal').length;
  return running + activeWorkers > 0 ? fillTemplate(labels.opening, { runs: running, workers: activeWorkers }) : null;
}
export function runDetailLines(run: RunView, work: WorkSurfaceLabels): WindowLine[] {
  const labels = work.jobs!;
  const section = (title: string): WindowLine => ({ spans: [span(title, { bold: true, role: 'accent' })] });
  const field = (label: string, text: string, muted = false): WindowLine => ({ label: [span(label, { bold: true })], spans: [span(text, muted ? { role: 'muted' } : {})] });
  const taskLabel = (task: RunView['tasks'][number], index: number) => task.taskBrief?.task ?? `${labels.tasks} ${index + 1}`;
  return [section(labels.state), { spans: [span(`[${runStateText(run, labels)}]`, { role: run.cancellationRequested ? 'warning' : 'accent' }), span(` · ${displayId(run.runId)}`, { role: 'muted' })] },
    section(labels.tasks), ...run.tasks.map((task, index) => ({ label: [span(taskLabel(task, index), { bold: true })], spans: [span(`[${fillTemplate(work.workerLine.card?.runPhases[task.phase] ?? task.phase, { count: 1 })}]`, { role: 'accent' }), span(` · ${displayId(task.id)}`, { role: 'muted' })] })),
    section(labels.attempts), ...run.tasks.map((task, index) => field(taskLabel(task, index), task.resultBrief?.attemptId ? displayId(task.resultBrief.attemptId) : labels.unknown, true)),
    section(labels.delivery), ...run.tasks.map((task, index) => ({ label: [span(taskLabel(task, index), { bold: true })], spans: task.resultBrief?.runDelivery
      ? [span(labels.runStates[task.resultBrief.runDelivery.state] ?? task.resultBrief.runDelivery.state), ...(task.resultBrief.runDelivery.commit ? [span(` · ${displayId(task.resultBrief.runDelivery.commit)}`, { role: 'muted' })] : [])] : [span(labels.unknown, { role: 'muted' })] }))];
}

/** Window and picker share the existing stack and project transported text below the Workline secret provider. */
export function JobWindow({ value, work, onAnswer }: { readonly value: JobWindowPresentation; readonly work: WorkSurfaceLabels; readonly onAnswer: (choice: string | null) => void }) {
  const known = useHumanTextSecrets(), project = (text: string) => projectHumanPickerText(text, known);
  const projectSpans = (spans: readonly Span[]) => spans.flatMap(item => project(item.text).spans.map(part => ({ ...item, ...part })));
  const title = project(value.title).spans;
  if (value.kind === 'job-picker') {
    const rows = value.rows.map(projectSpans);
    return <Window title={title} hints={work.window.pick} position={work.window.position} footerRows={ARROW_PICKER_ROWS + 2}
      footer={active => <ArrowPicker rows={rows.map(row => row.map(item => item.text).join(''))} styledRows={rows} active={active}
        onSelect={index => onAnswer(String(index))} onCancel={() => onAnswer(null)} />} />;
  }
  return <Window title={title} body={value.lines.map(line => ({ ...line, spans: projectSpans(line.spans), ...(line.label ? { label: projectSpans(line.label) } : {}) }))}
    hints={work.jobs?.hints ?? work.window.pick} position={work.window.position} onClose={() => onAnswer(null)} />;
}

export async function pickRun(panel: WorklinePanel, execution: LocalExecution, ledger: WorklineLedgerPorts, work: WorkSurfaceLabels, cancellable = false): Promise<RunView | null> {
  const runs = (await loadRunViewsForWatch(ledger)).filter(run => !cancellable || (run.state?.kind !== 'terminal' && !run.cancellationRequested));
  if (execution.signal.aborted) return null;
  if (!runs.length) {
    await panel.pick(execution, { kind: 'job-window', title: work.jobs!.runTitle, lines: [{ spans: [span(work.live!.empty, { role: 'muted' })] }] }, ['close']); return null;
  }
  const choice = await panel.pick(execution, { kind: 'job-picker', title: cancellable ? work.jobs!.cancelPickerTitle : work.live!.runsTitle,
    rows: runs.map(run => [span(runTitle(run, work.jobs!), { bold: true }), span(` [${runStateText(run, work.jobs!)}]`, { role: 'accent' }), span(` · ${displayId(run.runId)}`, { role: 'muted' })]) }, runs.map((_, index) => String(index)));
  if (choice === null || execution.signal.aborted) return null;
  // Refresh revision and cancellation eligibility after the choice; the service remains the authority at mutation time.
  const selected = await ledger.inspectRun(runs[Number(choice)]!.runId);
  return selected && (!cancellable || (selected.state?.kind !== 'terminal' && !selected.cancellationRequested)) ? selected : null;
}

export async function runJobWindow(command: 'workers' | 'runs' | 'run' | 'transcript', panel: WorklinePanel, execution: LocalExecution, ledger: WorklineLedgerPorts, work: WorkSurfaceLabels): Promise<string> {
  const labels = work.jobs!;
  if (command === 'workers' || command === 'runs') {
    const workers = command === 'workers' ? (await ledgerEntriesForWorkers(ledger, 'list')).filter((row): row is WorkLedgerWorkerEntry => row.kind === 'worker') : [];
    const runs = command === 'runs' ? await loadRunViewsForWatch(ledger) : [];
    const lines = command === 'workers' ? liveWindowLines('workers', { workers, runs: [] }, { live: work.live!, panel: work.panel, workerLine: work.workerLine }, Number.POSITIVE_INFINITY)
      : runs.length ? runs.map(run => ({ spans: [span(runTitle(run, labels), { bold: true }), span(` [${runStateText(run, labels)}]`, { role: 'accent' }), span(` · ${displayId(run.runId)}`, { role: 'muted' })] })) : [{ spans: [span(work.live!.empty, { role: 'muted' })] }];
    const title = command === 'workers' ? work.panel.title : work.live!.runsTitle;
    await panel.pick(execution, { kind: 'job-window', title, lines }, ['close']);
    return `${title}: ${command === 'workers' ? workers.length : runs.length}`;
  }
  if (command === 'run') {
    const run = await pickRun(panel, execution, ledger, work);
    if (run && !execution.signal.aborted) await panel.pick(execution, { kind: 'job-window', title: runTitle(run, labels), lines: runDetailLines(run, work) }, ['close']);
    return run ? `${labels.runTitle}: ${runTitle(run, labels)} [${runStateText(run, labels)}]` : fillTemplate(labels.closed, { title: labels.runTitle });
  }
  const workers = (await ledgerEntriesForWorkers(ledger, 'transcript')).filter((row): row is WorkLedgerWorkerEntry => row.kind === 'worker' && Boolean(row.attempt));
  if (!workers.length) {
    await panel.pick(execution, { kind: 'job-window', title: labels.transcriptTitle, lines: [{ spans: [span(work.live!.empty, { role: 'muted' })] }] }, ['close']);
    return fillTemplate(labels.closed, { title: labels.transcriptTitle });
  }
  const choice = await panel.pick(execution, { kind: 'job-picker', title: labels.transcriptTitle, rows: workers.map(worker => [span(fillTemplate(work.workerLine.ordinal, { n: worker.ordinal ?? 1 }), { bold: true }),
    span(` · ${worker.live?.model ?? worker.provider}`), span(` · ${displayId(worker.attempt!.attemptId)}`, { role: 'muted' })]) }, workers.map((_, index) => String(index)));
  if (choice === null || execution.signal.aborted) return fillTemplate(labels.closed, { title: labels.transcriptTitle });
  const worker = workers[Number(choice)]!, text = await ledger.inspectTranscript!(worker.attempt!);
  await panel.pick(execution, { kind: 'job-window', title: labels.transcriptTitle, lines: [{ spans: [span(fillTemplate(work.transcriptHeader, { n: worker.ordinal ?? 1, attempt: displayId(worker.attempt!.attemptId), task: displayId(worker.taskId) }), { role: 'muted' })] },
    ...text.split(/\r?\n/u).map(line => ({ spans: [span(line)], exact: true }))] }, ['close']);
  return `${labels.transcriptTitle}: ${fillTemplate(work.workerLine.ordinal, { n: worker.ordinal ?? 1 })}`;
}
