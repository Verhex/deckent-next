import { renderQueueStatus } from '#surfaces/core/effect-confirmation/index.js';
import type { RunView } from '#engine/index.js';
import { renderBriefLines, runHoldReasonText } from '#surfaces/core/monitor/index.js';
import { shortId, t, type Locale } from '#platform/index.js';
import { loadRunViewsForWatch, ledgerEntriesForWorkers, fillTemplate, type WorklineLedgerPorts, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { ArrowPicker, ARROW_PICKER_ROWS } from '#surfaces/core/terminal-picker/index.js';
import { projectHumanPickerText, span, useHumanTextSecrets, type Span } from '#surfaces/core/terminal-render/index.js';
import { Window, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { liveWindowLines } from './live-windows.js';
import type { LocalExecution, WorklinePanel } from './workline-panel.js';
import type { WorkSurfaceLabels } from './workline-actions.js';

export interface JobWindowLabels {
  readonly locale: Locale; readonly completed: string; readonly deliveryCounts: string; readonly deliveryPatch: string; readonly deliveryNext: string; readonly detailsUnavailable: string; readonly acceptanceEvidence: string; readonly trackingFull: string;
  readonly hints: string; readonly watchStatus: string; readonly push: string; readonly poll: string;
  readonly cancelPickerTitle: string; readonly system: string; readonly runTitle: string; readonly runFallback: string; readonly transcriptTitle: string;
  readonly state: string; readonly tasks: string; readonly attempts: string; readonly delivery: string; readonly unknown: string;
  readonly clearSession: string; readonly clearDetail: string; readonly kept: string; readonly closed: string;
  /** I-5: the opening line when work is running: `{runs}`, `{workers}`. */
  readonly opening: string;
  readonly runStates: Readonly<Record<string, string>>;
  /** Owner 2026-10-17: why a parked Run waits (`parked` state reasons), and the window's `{code}` / `{note}` lines. */
  readonly parkReasons?: Readonly<Record<string, string>>; readonly parkCode?: string; readonly parkNote?: string;
  /** alpha.54 g: a hold laid over another park (`operatorHold`), said next to the park's own reason. */
  readonly heldOver?: string;
}
export type JobWindowPresentation = Readonly<{ kind: 'job-window'; title: string; lines: readonly WindowLine[] }>
  | Readonly<{ kind: 'job-picker'; title: string; rows: readonly (readonly Span[])[] }>;

/** Only projections, not hashes or command text, provide a run's human title. */
export function displayId(value: string): string { return value.length > 12 ? shortId(value).slice(0, 8) : value; }

/** The Brain-authored title when a task carries one, else the first line of the task text with its whitespace collapsed (owner 2026-10-17:
 * a row showed the whole multi-line task). */
export function runTitle(run: RunView, labels: JobWindowLabels): string {
  const titled = run.tasks.find(task => task.taskBrief?.title)?.taskBrief?.title;
  if (titled) return titled;
  const task = run.tasks.find(task => task.taskBrief?.task?.trim())?.taskBrief?.task;
  return task ? task.trim().split(/\r?\n/u)[0]!.replace(/\s+/gu, ' ').trim() : labels.runFallback;
}
/** A parked Run's reason in the catalog's words, or null when the Run is not parked or the words are absent. */
export const parkReasonText = (run: RunView, labels: JobWindowLabels): string | null => run.state?.kind === 'parked' ? labels.parkReasons?.[run.state.reason] ?? null : null;
/** S6R-6: a held Run's hold in words (the shared renderer: a system hold's catalog text and case reference, never its raw code). */
export const runHoldText = (run: RunView, labels: JobWindowLabels) => runHoldReasonText(run.state, labels.locale);
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
/**
 * The state word of a Run in the Runs list and picker: the state, and for a parked Run its reason; a hold laid over another park says both
 * (the hold record's typed reason is the park reason `operator-hold`, or the `operatorHold` overlay the original reason stays under).
 */
export function runListStateText(run: RunView, labels: JobWindowLabels): string {
  const state = runStateText(run, labels), reason = parkReasonText(run, labels);
  if (run.state?.kind !== 'parked' || !reason) return state;
  const over = run.state.operatorHold && run.state.reason !== 'operator-hold' ? labels.heldOver : undefined;
  return `${state}: ${reason}${over ? `, ${over}` : ''}`;
}
/** The summary lines of each queue row of a Run, from the ledger's reader (the card's own renderer); a failed read is the card's not-available line; undefined = no reader or no rows. */
export async function queueRowSummaries(run: RunView, read: WorklineLedgerPorts['queueSummaryLines']): Promise<readonly (readonly string[])[] | undefined> {
  const views = run.targetQueue?.records ?? [];
  return read && views.length ? read(views).catch(() => views.map(() => [])) : undefined;
}
export function runDetailLines(run: RunView, work: WorkSurfaceLabels, summaries?: readonly (readonly string[])[]): WindowLine[] {
  const labels = work.jobs!;
  const section = (title: string): WindowLine => ({ spans: [span(title, { bold: true, role: 'accent' })] });
  const field = (label: string, text: string, muted = false): WindowLine => ({ label: [span(label, { bold: true })], spans: [span(text, muted ? { role: 'muted' } : {})] });
  const taskLabel = (task: RunView['tasks'][number], index: number) => (task.resultBrief ? task.taskBrief?.task : undefined) ?? `${labels.tasks} ${index + 1}`;
  const parked = run.state?.kind === 'parked' ? run.state : null, reason = parkReasonText(run, labels), note = runHoldText(run, labels); // S6R-6: words, never a raw code
  return [section(labels.state), { spans: [span(`[${runStateText(run, labels)}]`, { role: run.cancellationRequested ? 'warning' : 'accent' }), span(` · ${displayId(run.runId)}`, { role: 'muted' })] },
    ...(parked ? [{ spans: [span(reason ?? parked.reason, { role: 'warning' }), ...(parked.failureCode && labels.parkCode ? [span(` · ${fillTemplate(labels.parkCode, { code: parked.failureCode })}`, { role: 'muted' })] : []),
      ...(note && labels.parkNote ? [span(` · ${fillTemplate(labels.parkNote, { note })}`)] : [])] }] : []),
    section(labels.tasks), ...run.tasks.map((task, index) => ({ label: [span(taskLabel(task, index), { bold: true })], spans: [span(`[${fillTemplate(work.workerLine.card?.runPhases[task.phase] ?? task.phase, { count: 1 })}]`, { role: 'accent' }), span(` · ${displayId(task.id)}`, { role: 'muted' })] })),
    section(labels.attempts), ...run.tasks.map((task, index) => field(taskLabel(task, index), task.resultBrief?.attemptId ? displayId(task.resultBrief.attemptId) : labels.unknown, true)),
    section(labels.delivery), ...run.tasks.map((task, index) => ({ label: [span(taskLabel(task, index), { bold: true })], spans: task.resultBrief?.runDelivery
      ? [span(labels.runStates[task.resultBrief.runDelivery.state] ?? task.resultBrief.runDelivery.state), ...(task.resultBrief.runDelivery.commit ? [span(` · ${displayId(task.resultBrief.runDelivery.commit)}`, { role: 'muted' })] : [])] : [span(labels.unknown, { role: 'muted' })] })),
    ...(run.targetQueue?.records ?? []).flatMap((view, index) => [...renderQueueStatus(view, labels.locale).split('\n'),
      ...summaries?.[index] ?? []].map(text => ({ spans: [span(text)] }))),
    ...(run.targetQueue?.truncated ? [{ spans: [span(t('queue.truncated', {}, labels.locale), { role: 'warning' })] }] : []),
    ...run.tasks.flatMap((task, index) => [section(taskLabel(task, index)), ...(task.resultBrief
      ? renderBriefLines(task.taskBrief, task.resultBrief, labels.locale).map(text => ({ spans: [span(text)] }))
      : [{ spans: [span(labels.detailsUnavailable, { role: 'warning' })] }])])];
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
    rows: runs.map(run => [span(runTitle(run, work.jobs!), { bold: true }), span(` [${runListStateText(run, work.jobs!)}]`, { role: 'accent' }), span(` · ${displayId(run.runId)}`, { role: 'muted' })]) }, runs.map((_, index) => String(index)));
  if (choice === null || execution.signal.aborted) return null;
  // Refresh revision and cancellation eligibility after the choice; the service remains the authority at mutation time.
  const selected = await ledger.inspectRun(runs[Number(choice)]!.runId);
  return selected && (!cancellable || (selected.state?.kind !== 'terminal' && !selected.cancellationRequested)) ? selected : null;
}

/** `onSeen`: the person opened a Run window (its id) or the Run list (no id); the session's active-work strip drops finished Runs then. */
export async function runJobWindow(command: 'workers' | 'runs' | 'run' | 'transcript', panel: WorklinePanel, execution: LocalExecution, ledger: WorklineLedgerPorts, work: WorkSurfaceLabels,
  onSeen?: (runId?: string) => void): Promise<string> {
  const labels = work.jobs!;
  if (command === 'workers' || command === 'runs') {
    const workers = command === 'workers' ? (await ledgerEntriesForWorkers(ledger, 'list')).filter((row): row is WorkLedgerWorkerEntry => row.kind === 'worker') : [];
    const runs = command === 'runs' ? await loadRunViewsForWatch(ledger) : [];
    const lines = command === 'workers' ? liveWindowLines('workers', { workers, runs: [] }, { live: work.live!, panel: work.panel, workerLine: work.workerLine }, Number.POSITIVE_INFINITY)
      : runs.length ? runs.map(run => ({ spans: [span(runTitle(run, labels), { bold: true }), span(` [${runListStateText(run, labels)}]`, { role: 'accent' }), span(` · ${displayId(run.runId)}`, { role: 'muted' })] })) : [{ spans: [span(work.live!.empty, { role: 'muted' })] }];
    const title = command === 'workers' ? work.panel.title : work.live!.runsTitle;
    await panel.pick(execution, { kind: 'job-window', title, lines }, ['close']);
    if (command === 'runs') onSeen?.();
    return `${title}: ${command === 'workers' ? workers.length : runs.length}`;
  }
  if (command === 'run') {
    const run = await pickRun(panel, execution, ledger, work);
    if (run && !execution.signal.aborted) { await panel.pick(execution, { kind: 'job-window', title: runTitle(run, labels), lines: runDetailLines(run, work, await queueRowSummaries(run, ledger.queueSummaryLines)) }, ['close']); onSeen?.(run.runId); }
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
