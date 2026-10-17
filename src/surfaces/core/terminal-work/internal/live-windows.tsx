import type { RunView } from '#engine/index.js';
import type { JobWindowLabels } from './job-windows.js';
import { runViewToLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { useState, type ReactElement } from 'react';
import { useWindowSize } from 'ink';
import { shortId } from '#platform/index.js';
import { LEDGER_TAIL_LIMIT, fillTemplate, formatRunCardLines, formatWorkerLine, type LedgerCardLabels, type RunControlAction, type WorkerLineLabels, type WorkLedgerRunEntry, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { span, wrapCells, type Span } from '#surfaces/core/terminal-render/index.js';
import { Window, WINDOW_RESERVED_ROWS, useWindowReserve, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { runControlActions, type RunControlLabels } from './run-control.js';

/** K1 (owner 2026-10-14): `runs` is the one Runs window (tabs: runs, workers) that replaces the eight work commands; `monitor` the monitor's own body. */
export type LiveWindowKind = 'runs' | 'monitor';
export type RunsTab = 'runs' | 'workers';

/** Catalog words of the live windows (`terminal.live.*`) beside the worker panel's own title and `+N more` (they name the same list). */
export interface WorkerPanelLabels {
  readonly title: string;
  /** `+{count} more` */
  readonly more: string;
}
export interface LiveWindowLabels {
  readonly monitorTitle: string; readonly runsTitle: string;
  readonly hints: string; readonly monitorHints: string;
  /** `{workers}` `{runs}` */
  readonly statusTasks: string;
  readonly empty: string;
  /** `+{count} more` */
  readonly runsMore: string;
  /** Scrollback line when the Runs window closes: what it last showed (the finished output stays in the scrollback). */
  readonly closedTasks: string;
  readonly monitorFailed: string; readonly closedMonitor?: string;
  /** The Runs window's tab names, its base key hints (`↑↓`, Tab, Esc, the unfocused close key) and the word of each row key. */
  readonly tabRuns: string; readonly tabWorkers: string; readonly runsHints: string;
  readonly keys: Readonly<{ detail: string; transcript: string; cancel: string; deliver: string; answer: string }>;
}

/** The monitor body is rendered by the host that owns it; this unit never imports the monitor (T3 L5, split step 7). */
export interface LiveWindowView { readonly active: boolean; readonly onClose: () => void; readonly size: { readonly columns: number; readonly rows: number } }
export type MonitorWindowRender = (view: LiveWindowView) => ReactElement;
export type MonitorWindowLoader = () => Promise<MonitorWindowRender>;

/** A scrolling window holds this many rows per list; the rest is one `+N more` line. */
export const LIVE_WINDOW_MAX_ROWS = LEDGER_TAIL_LIMIT;

export interface LiveWindowData {
  readonly workers: readonly WorkLedgerWorkerEntry[];
  readonly runs: readonly WorkLedgerRunEntry[];
}
/**
 * One row action of the Runs window, carried out of band to the work surface: `run` the Run's detail window (also the active work strip's
 * Enter), `transcript` a worker's sealed transcript, `cancel` the y/N cancellation card (K4), `hold`/`resume`/`close` the Y1 control cards,
 * `deliver` the delivery window (K6), `answer` the needs-input answer card (K7). Each opens its own card; none decides anything here.
 */
export type TaskWindowAction = Readonly<{ action: 'transcript' | 'cancel' | 'run' | RunControlAction | 'deliver' | 'answer'; target: WorkLedgerWorkerEntry | WorkLedgerRunEntry }>;
export type RunsRowKey = Exclude<TaskWindowAction['action'], 'transcript' | 'run'>;
/** One typed letter per row key; Ctrl/Alt chords, pasted or coalesced text never select one (the decision-key rule for an opening key). */
const ROW_KEYS: Readonly<Record<string, RunsRowKey>> = Object.freeze({ x: 'cancel', h: 'hold', r: 'resume', c: 'close', d: 'deliver', a: 'answer' });
export function runsRowKey(input: string, key: Readonly<{ ctrl?: boolean; meta?: boolean }>): RunsRowKey | null {
  return key.ctrl || key.meta || input.length !== 1 ? null : ROW_KEYS[input] ?? null;
}
/** What this terminal can offer as row keys (its ports and words); the service still authorizes and checks state at the confirmed revision. */
export type RunsRowOffer = Readonly<{ cancel: boolean; control: boolean; answer: boolean; deliverable: (run: RunView) => boolean }>;
/** The question a needs-input task asks, or null (K7: `a` answers it). */
export function needsInputTask(run: RunView): Readonly<{ taskId: string; question: string }> | null {
  for (const task of run.tasks ?? []) if (task.decision?.reason === 'needs-input' && task.decision.question) return { taskId: task.id, question: task.decision.question };
  return null;
}
/** The keys a Run row offers from its observed state (display only). A worker row offers the cancellation of its Run. */
export function runsRowKeys(target: WorkLedgerWorkerEntry | WorkLedgerRunEntry, offer: RunsRowOffer): readonly RunsRowKey[] {
  if (target.kind === 'worker') return offer.cancel ? ['cancel'] : [];
  const view = (target as LiveRunEntry).view;
  if (!view) return [];
  const open = view.state?.kind !== 'terminal' && !view.cancellationRequested;
  return [...(open && offer.cancel ? ['cancel' as const] : []), ...(offer.control && view.state ? runControlActions(view) : []),
    ...(offer.deliverable(view) ? ['deliver' as const] : []), ...(open && offer.answer && needsInputTask(view) ? ['answer' as const] : [])];
}
export interface LiveWindowRenderLabels {
  readonly live: LiveWindowLabels; readonly panel: WorkerPanelLabels; readonly workerLine: WorkerLineLabels; readonly jobs?: JobWindowLabels | undefined;
  readonly runControl?: RunControlLabels | undefined;
}

type LiveRunEntry = WorkLedgerRunEntry & Readonly<{ title?: string; state?: string; view?: RunView }>;
/** Display facts stay private to this unit; canonical ledger DTOs and bridge contracts are unchanged. */
export function liveRunEntry(run: RunView, id: string): LiveRunEntry {
  const title = run.tasks.find(task => task.taskBrief?.task)?.taskBrief?.task;
  const state = run.state?.kind === 'terminal' ? run.state.outcome : run.state?.kind;
  return { ...runViewToLedgerEntry(run, id), ...(title ? { title } : {}), ...(state ? { state } : {}), view: run };
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

/** Pure body of one tab of the Runs window: one line per Run or worker; nothing observed yet reads as one muted line. */
export function liveWindowLines(tab: RunsTab, data: LiveWindowData, labels: LiveWindowRenderLabels, limit = LIVE_WINDOW_MAX_ROWS): readonly WindowLine[] {
  const none: WindowLine = { spans: [span(labels.live.empty, { role: 'muted' })] };
  if (tab === 'workers') return data.workers.length ? workerLines(data.workers, labels, limit) : [none];
  return data.runs.length ? runLines(data.runs, labels, limit) : [none];
}
export function liveWindowStatus(data: LiveWindowData, labels: LiveWindowRenderLabels): string {
  return fillTemplate(labels.live.statusTasks, { workers: data.workers.length, runs: data.runs.length });
}
/** The scrollback line left behind when the Runs window closes: what it showed at its last read. */
export function liveWindowClosedText(data: LiveWindowData, labels: LiveWindowLabels): string {
  return fillTemplate(labels.closedTasks, { workers: data.workers.length, runs: data.runs.length });
}
/** The tab line: the open tab marked, each with its count. */
export function runsTabLine(tab: RunsTab, data: LiveWindowData, labels: LiveWindowLabels): WindowLine {
  const item = (name: RunsTab, text: string, count: number) => span(name === tab ? `[${text} ${count}]` : ` ${text} ${count} `, name === tab ? { bold: true, role: 'accent' } : { role: 'muted' });
  return { spans: [item('runs', labels.tabRuns, data.runs.length), span('  '), item('workers', labels.tabWorkers, data.workers.length)] };
}
/** Key hints for the selected row: the base keys, Enter's meaning on this tab, then only the keys this row offers. */
export function runsWindowHints(tab: RunsTab, keys: readonly RunsRowKey[], labels: LiveWindowRenderLabels): string {
  const words = labels.live.keys, control = labels.runControl;
  const word = (key: RunsRowKey) => key === 'cancel' ? words.cancel : key === 'deliver' ? words.deliver : key === 'answer' ? words.answer
    : key === 'hold' ? control?.keyHold : key === 'resume' ? control?.keyResume : control?.keyClose;
  return [labels.live.runsHints, tab === 'runs' ? words.detail : words.transcript, ...keys.map(word).filter((text): text is string => Boolean(text))].join(' · ');
}

/** Frame rows around a window body (two borders, title row, hint row) and the border/padding columns: the same numbers `Window` lays out with. */
const FRAME_ROWS = 4, FRAME_COLUMNS = 4, MONITOR_MIN_ROWS = 6, FALLBACK_COLUMNS = 80, FALLBACK_ROWS = 24;

/**
 * K1/K5: the one Runs window. It updates in place from the watch it owns; opened by the person it takes focus, opened after `/do` it waits
 * in the background with the composer focused (Ctrl+O focuses it, Ctrl+X closes it from the input). Tab switches runs/workers; Enter opens the
 * Run's detail or the worker's transcript; x/h/r/c/d/a open the card of the selected row's action (only the keys its state offers).
 */
/** The Runs window's open tab and selected row; its host keeps them, so a card that covers the window does not reset them. */
export type RunsWindowView = Readonly<{ tab: RunsTab; selectedId: string | null }>;
export const RUNS_WINDOW_INITIAL: RunsWindowView = Object.freeze({ tab: 'runs', selectedId: null });
export function RunsLiveWindow({ data, labels, position, statusText, statusLines, offer, onClose, onAction, view: held, onView, runsUnavailable }: {
  /** The runs tab's line when this terminal cannot list Runs (the workers tab still works); absent: Runs are listed. */
  readonly runsUnavailable?: string | undefined;
  readonly data: LiveWindowData; readonly labels: LiveWindowRenderLabels; readonly position: string; readonly statusText?: string | undefined; readonly statusLines?: readonly string[] | undefined;
  readonly offer: RunsRowOffer; readonly onClose: () => void; readonly onAction?: ((action: TaskWindowAction) => void) | undefined;
  readonly view?: RunsWindowView | undefined; readonly onView?: ((view: RunsWindowView) => void) | undefined;
}) {
  const [own, setOwn] = useState<RunsWindowView>(RUNS_WINDOW_INITIAL), current = held ?? own;
  const update = (next: RunsWindowView) => { setOwn(next); onView?.(next); };
  const { tab, selectedId } = current;
  const setTab = (next: RunsTab) => update({ tab: next, selectedId: null }), setSelectedId = (id: string | null) => update({ tab, selectedId: id });
  // Every row stays reachable: the body scrolls (End, PgDn) and follows the selection; nothing is cut to a `+N more` line here.
  const targets: readonly (WorkLedgerWorkerEntry | WorkLedgerRunEntry)[] = tab === 'runs' ? (runsUnavailable ? [] : data.runs) : data.workers;
  const keyOf = (target: TaskWindowAction['target']) => target.kind === 'run' ? `run:${target.scopeId}:${target.runId}`
    : `worker:${target.scopeId}:${target.taskId}:${JSON.stringify(target.attempt ?? target.provider)}`;
  const selected = Math.max(0, targets.findIndex(target => keyOf(target) === selectedId)), row = targets[selected];
  const keys = row ? runsRowKeys(row, offer) : [];
  const status: readonly Span[] = [span([liveWindowStatus(data, labels), statusText].filter(Boolean).join(' · '))];
  const notes = (statusLines ?? []).map(text => ({ spans: [span(text, { role: 'muted' as const })] }));
  const lines = tab === 'runs' && runsUnavailable ? [{ spans: [span(runsUnavailable, { role: 'muted' as const })] }] : liveWindowLines(tab, data, labels, Number.POSITIVE_INFINITY);
  const body = targets.length ? lines.map((line, index) => index < targets.length ? { spans: [span(index === selected ? '› ' : '  ', index === selected ? { role: 'accent', bold: true } : {}), ...line.spans] } : line) : lines;
  return <Window title={[span(labels.live.runsTitle)]} status={status} body={[...notes, runsTabLine(tab, data, labels.live), { spans: [] }, ...body]}
    hints={runsWindowHints(tab, keys, labels)} position={position} onClose={onClose} passive reveal={notes.length + 2 + selected}
    onInput={(input, key) => {
      if (key.tab && !key.shift && !key.ctrl && !key.meta) { setTab(tab === 'runs' ? 'workers' : 'runs'); return true; }
      if (key.ctrl && !key.meta && input === 'x') { onClose(); return true; }
      if (key.ctrl || key.meta || key.shift) return false;
      if ((key.upArrow || key.downArrow) && targets.length) {
        const next = (selected + (key.upArrow ? -1 : 1) + targets.length) % targets.length;
        setSelectedId(keyOf(targets[next]!)); return true;
      }
      if (!row) return false;
      if (key.return) { onAction?.({ action: row.kind === 'run' ? 'run' : 'transcript', target: row }); return true; }
      const pressed = runsRowKey(input, key);
      if (pressed && keys.includes(pressed)) { onAction?.({ action: pressed, target: row }); return true; }
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
