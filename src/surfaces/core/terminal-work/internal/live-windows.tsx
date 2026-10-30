import type { RunView } from '#engine/index.js';
import type { JobWindowLabels } from './job-windows.js';
import { runViewToLedgerEntry, LEDGER_TAIL_LIMIT, fillTemplate, formatRunCardLines, formatWorkerLine, type LedgerCardLabels, type WorkerLineLabels, type WorkLedgerRunEntry, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { useState, type ReactElement } from 'react';
import { useWindowSize } from 'ink';
import { shortId } from '#platform/index.js';
import { span, wrapCells, type Span } from '#surfaces/core/terminal-render/index.js';
import { Window, WINDOW_RESERVED_ROWS, useWindowReserve, type WindowLine } from '#surfaces/core/terminal-window/index.js';

/** What a live window shows: `tasks` follows workers and runs together (T3 L5), `monitor` the monitor's own body. */
export type LiveWindowKind = 'tasks' | 'monitor';

/** Catalog words of the live windows (`terminal.live.*`) beside the worker panel's own title and `+N more` (they name the same list). */
export interface WorkerPanelLabels {
  readonly title: string;
  /** `+{count} more (/workers lists all)` */
  readonly more: string;
}
export interface LiveWindowLabels {
  readonly tasksHints?: string;
  readonly monitorTitle: string; readonly runsTitle: string; readonly tasksTitle: string;
  readonly hints: string; readonly monitorHints: string;
  /** `{workers}` `{runs}` */
  readonly statusTasks: string;
  readonly empty: string;
  /** `+{count} more (/runs lists all)` */
  readonly runsMore: string;
  /** Scrollback line when a window closes: what it last showed (the finished output stays in the scrollback). */
  readonly closedTasks: string;
  readonly monitorFailed: string; readonly closedMonitor?: string;
}

/** The monitor body is rendered by the host that owns it; this unit never imports the monitor (T3 L5, split step 7). */
export interface LiveWindowView { readonly active: boolean; readonly onClose: () => void; readonly size: { readonly columns: number; readonly rows: number } }
export type MonitorWindowRender = (view: LiveWindowView) => ReactElement;
export type MonitorWindowLoader = () => Promise<MonitorWindowRender>;

/** A scrolling window holds this many rows per list; the rest is one `+N more` line (the full lists stay in `/workers` and `/runs`). */
export const LIVE_WINDOW_MAX_ROWS = LEDGER_TAIL_LIMIT;

export interface LiveWindowData {
  readonly workers: readonly WorkLedgerWorkerEntry[];
  readonly runs: readonly WorkLedgerRunEntry[];
}
/** `run` (active work strip): open the selected Run's existing detail window. */
export type TaskWindowAction = Readonly<{ action: 'transcript' | 'cancel' | 'run'; target: WorkLedgerWorkerEntry | WorkLedgerRunEntry }>;
export interface LiveWindowRenderLabels {
  readonly live: LiveWindowLabels; readonly panel: WorkerPanelLabels; readonly workerLine: WorkerLineLabels; readonly jobs?: JobWindowLabels | undefined;
}

type LiveRunEntry = WorkLedgerRunEntry & Readonly<{ title?: string; state?: string }>;
/** Display facts stay private to this unit; canonical ledger DTOs and bridge contracts are unchanged. */
export function liveRunEntry(run: RunView, id: string): LiveRunEntry {
  const title = run.tasks.find(task => task.taskBrief?.task)?.taskBrief?.task;
  const state = run.state?.kind === 'terminal' ? run.state.outcome : run.state?.kind;
  return { ...runViewToLedgerEntry(run, id), ...(title ? { title } : {}), ...(state ? { state } : {}) };
}

function workerLines(workers: readonly WorkLedgerWorkerEntry[], labels: LiveWindowRenderLabels, limit: number): WindowLine[] {
  const rows: WindowLine[] = workers.slice(0, limit).map((entry, index) => {
    const worker = entry.ordinal === undefined ? { ...entry, ordinal: index + 1 } : entry;
    const row = formatWorkerLine(worker, labels.workerLine);
    return { spans: [span(`[${labels.workerLine.card?.workerProcess[worker.process] ?? worker.process}] `, { role: worker.process === 'running' ? 'accent' : 'muted' }), span(row.text, row.tone === 'error' ? { role: 'error' } : row.tone === 'muted' ? { role: 'muted' } : {})] };
  });
  if (workers.length > limit) rows.push({ spans: [span(fillTemplate(labels.panel.more, { count: workers.length - limit }), { role: 'muted' })] });
  return rows;
}

function runLines(runs: readonly WorkLedgerRunEntry[], labels: LiveWindowRenderLabels, limit: number): WindowLine[] {
  const card: LedgerCardLabels | undefined = labels.workerLine.card;
  const rows: WindowLine[] = runs.slice(0, limit).map((entry, index) => {
    const run = entry as LiveRunEntry;
    const text = card ? formatRunCardLines(run, card).slice(1).join(' · ') : `${run.revision} · ${run.taskPhases}`;
    return { spans: [span(run.title ?? `${labels.live.runsTitle} ${index + 1}`, { bold: true }),
      ...(run.state ? [span(` [${labels.jobs?.runStates[run.state] ?? run.state}]`, { role: run.cancellationRequested ? 'warning' : 'accent' })] : []),
      span(` · ${text}`), span(` · ${shortId(run.runId)}`, { role: 'muted' })] };
  });
  if (runs.length > limit) rows.push({ spans: [span(fillTemplate(labels.live.runsMore, { count: runs.length - limit }), { role: 'muted' })] });
  return rows;
}

/** Pure body of a list: one line per worker (`/workers`) or both sections of `/tasks` under their own heading; nothing observed yet reads as one muted line. */
export function liveWindowLines(kind: 'workers' | 'tasks', data: LiveWindowData, labels: LiveWindowRenderLabels, limit = LIVE_WINDOW_MAX_ROWS): readonly WindowLine[] {
  const heading = (text: string): WindowLine => ({ spans: [span(text, { bold: true })] });
  const none: WindowLine = { spans: [span(labels.live.empty, { role: 'muted' })] };
  if (kind === 'workers') return data.workers.length ? workerLines(data.workers, labels, limit) : [none];
  return [heading(labels.panel.title), ...(data.workers.length ? workerLines(data.workers, labels, limit) : [none]), { spans: [] },
    heading(labels.live.runsTitle), ...(data.runs.length ? runLines(data.runs, labels, limit) : [none])];
}

export function liveWindowStatus(data: LiveWindowData, labels: LiveWindowRenderLabels): string {
  return fillTemplate(labels.live.statusTasks, { workers: data.workers.length, runs: data.runs.length });
}
/** The scrollback line left behind when the `/tasks` window closes: what it showed at its last read. */
export function liveWindowClosedText(data: LiveWindowData, labels: LiveWindowLabels): string {
  return fillTemplate(labels.closedTasks, { workers: data.workers.length, runs: data.runs.length });
}

/** Frame rows around a window body (two borders, title row, hint row) and the border/padding columns: the same numbers `Window` lays out with. */
const FRAME_ROWS = 4, FRAME_COLUMNS = 4, MONITOR_MIN_ROWS = 6, FALLBACK_COLUMNS = 80, FALLBACK_ROWS = 24;

/**
 * The `/tasks` window updates in place and takes the keys: Up/Down select a worker or Run, Enter opens its transcript, x its existing
 * cancellation approval; Esc closes it and stops the watch.
 */
export function LiveWatchWindow({ data, labels, position, statusText, statusLines, onClose, onAction }: {
  readonly data: LiveWindowData; readonly labels: LiveWindowRenderLabels; readonly position: string; readonly statusText?: string | undefined; readonly statusLines?: readonly string[] | undefined; readonly onClose: () => void;
  readonly onAction?: ((action: TaskWindowAction) => void) | undefined;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const targets = [...data.workers, ...data.runs];
  const keyOf = (target: TaskWindowAction['target']) => target.kind === 'run' ? `run:${target.scopeId}:${target.runId}`
    : `worker:${target.scopeId}:${target.taskId}:${JSON.stringify(target.attempt ?? target.provider)}`;
  const selected = Math.max(0, targets.findIndex(target => keyOf(target) === selectedId));
  const status: readonly Span[] = [span([liveWindowStatus(data, labels), statusText].filter(Boolean).join(' · '))];
  const notes = (statusLines ?? []).map(text => ({ spans: [span(text, { role: 'muted' })] }));
  const taskRows = targets.map((target, index) => ({ spans: [span(`${index === selected ? '>' : ' '} `),
    ...(target.kind === 'worker' ? workerLines([target], labels, 1)[0]!.spans : runLines([target], labels, 1)[0]!.spans)] }));
  const taskBody = [{ spans: [span(labels.panel.title, { bold: true })] }, ...taskRows.slice(0, data.workers.length),
    { spans: [] }, { spans: [span(labels.live.runsTitle, { bold: true })] }, ...taskRows.slice(data.workers.length)];
  return <Window title={[span(labels.live.tasksTitle)]} status={status}
    body={[...notes, ...(targets.length ? taskBody : liveWindowLines('tasks', data, labels))]}
    hints={labels.live.tasksHints ?? labels.live.hints} position={position} onClose={onClose}
    reveal={notes.length + selected + (selected >= data.workers.length ? 3 : 1)} onInput={(input, key) => {
      if (key.ctrl || key.meta || key.shift) return false;
      if ((key.upArrow || key.downArrow) && targets.length) {
        const next = (selected + (key.upArrow ? -1 : 1) + targets.length) % targets.length;
        setSelectedId(keyOf(targets[next]!)); return true;
      }
      if ((key.return || input === 'x') && targets[selected]) {
        onAction?.({ action: key.return ? 'transcript' : 'cancel', target: targets[selected]! }); return true;
      }
      return false;
    }} />;
}

/**
 * The monitor in a window: the frame is the window's, the body is the monitor's own view (tabs, selection, filter, details) given the
 * rows and columns left on the terminal. The body reads keys only while this window is on top; `q` and Esc (when it has nothing to back out of) close it.
 */
export function MonitorWindow({ render, labels, onClose }: { readonly render: MonitorWindowRender; readonly labels: LiveWindowLabels; readonly onClose: () => void }) {
  const size = useWindowSize(), reserve = useWindowReserve(), reserved = reserve ?? WINDOW_RESERVED_ROWS;
  const columns = size.columns || FALLBACK_COLUMNS, terminalRows = size.rows || FALLBACK_ROWS, width = Math.max(1, columns - FRAME_COLUMNS);
  const rows = Math.max(reserve === undefined ? MONITOR_MIN_ROWS : 1, terminalRows - reserved - FRAME_ROWS - (wrapCells(labels.monitorHints, width).length - 1));
  return <Window title={[span(labels.monitorTitle)]} hints={labels.monitorHints} position="" footerRows={rows} onClose={onClose}
    footer={focused => render({ active: focused, onClose, size: { columns: width, rows } })} />;
}
