import { renderQueueStatus } from '#surfaces/core/effect-confirmation/index.js';
import type { RunView } from '#engine/index.js';
import { renderBriefLines } from '#surfaces/core/monitor/index.js';
import { shortId, t, type Locale } from '#platform/index.js';
import { fillTemplate } from '#surfaces/core/terminal-ledger/index.js';
import { ArrowPicker, ARROW_PICKER_ROWS } from '#surfaces/core/terminal-picker/index.js';
import { projectHumanPickerText, span, useHumanTextSecrets, type Span } from '#surfaces/core/terminal-render/index.js';
import { Window, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import type { WorkSurfaceLabels } from './workline-actions.js';

export interface JobWindowLabels {
  readonly locale: Locale; readonly completed: string; readonly deliveryCounts: string; readonly deliveryPatch: string; readonly deliveryNext: string; readonly detailsUnavailable: string; readonly trackingFull: string;
  readonly hints: string; readonly watchStatus: string; readonly push: string; readonly poll: string;
  readonly cancelPickerTitle: string; readonly system: string; readonly runTitle: string; readonly runFallback: string; readonly transcriptTitle: string;
  readonly state: string; readonly tasks: string; readonly attempts: string; readonly delivery: string; readonly unknown: string;
  readonly clearSession: string; readonly clearDetail: string; readonly kept: string; readonly closed: string;
  /** I-5: the opening line when work is running: `{runs}`, `{workers}`. */
  readonly opening: string;
  readonly runStates: Readonly<Record<string, string>>;
  /** Owner 2026-10-17: why a parked Run waits (`parked` state reasons), and the window's `{code}` / `{note}` lines. */
  readonly parkReasons?: Readonly<Record<string, string>>; readonly parkCode?: string; readonly parkNote?: string;
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
export function parkReasonText(run: RunView, labels: JobWindowLabels): string | null {
  return run.state?.kind === 'parked' ? labels.parkReasons?.[run.state.reason] ?? null : null;
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
  const taskLabel = (task: RunView['tasks'][number], index: number) => (task.resultBrief ? task.taskBrief?.task : undefined) ?? `${labels.tasks} ${index + 1}`;
  const parked = run.state?.kind === 'parked' ? run.state : null, reason = parkReasonText(run, labels), note = parked?.operatorHold?.note ?? parked?.note;
  return [section(labels.state), { spans: [span(`[${runStateText(run, labels)}]`, { role: run.cancellationRequested ? 'warning' : 'accent' }), span(` · ${displayId(run.runId)}`, { role: 'muted' })] },
    ...(parked ? [{ spans: [span(reason ?? parked.reason, { role: 'warning' }), ...(parked.failureCode && labels.parkCode ? [span(` · ${fillTemplate(labels.parkCode, { code: parked.failureCode })}`, { role: 'muted' })] : []),
      ...(note && labels.parkNote ? [span(` · ${fillTemplate(labels.parkNote, { note })}`)] : [])] }] : []),
    section(labels.tasks), ...run.tasks.map((task, index) => ({ label: [span(taskLabel(task, index), { bold: true })], spans: [span(`[${fillTemplate(work.workerLine.card?.runPhases[task.phase] ?? task.phase, { count: 1 })}]`, { role: 'accent' }), span(` · ${displayId(task.id)}`, { role: 'muted' })] })),
    section(labels.attempts), ...run.tasks.map((task, index) => field(taskLabel(task, index), task.resultBrief?.attemptId ? displayId(task.resultBrief.attemptId) : labels.unknown, true)),
    section(labels.delivery), ...run.tasks.map((task, index) => ({ label: [span(taskLabel(task, index), { bold: true })], spans: task.resultBrief?.runDelivery
      ? [span(labels.runStates[task.resultBrief.runDelivery.state] ?? task.resultBrief.runDelivery.state), ...(task.resultBrief.runDelivery.commit ? [span(` · ${displayId(task.resultBrief.runDelivery.commit)}`, { role: 'muted' })] : [])] : [span(labels.unknown, { role: 'muted' })] })),
    ...(run.targetQueue?.records ?? []).flatMap(view => renderQueueStatus(view, labels.locale).split('\n').map(text => ({ spans: [span(text)] }))),
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
