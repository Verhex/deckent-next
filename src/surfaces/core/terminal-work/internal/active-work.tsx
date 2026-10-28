import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { RunView } from '#engine/index.js';
import { fillTemplate, formatDuration, type WorkerLineLabels } from '#surfaces/core/terminal-ledger/index.js';
import { SpanText, cells, projectHumanPickerText, span, truncateEnd, useHumanTextSecrets, useRenderGlyphs, type Span, type SpanRole } from '#surfaces/core/terminal-render/index.js';
import { useFocusOwner } from '#surfaces/core/terminal-window/index.js';
import { runStatusKey } from '#surfaces/core/cli-human/index.js';
import { displayId, parkReasonText, runStateText, runTitle, type JobWindowLabels } from './job-windows.js';
import type { TrackedRun } from './run-completion.js';

/**
 * TERMINAL-SABIT slice 2 (owner 2026-10-14): the active work strip above the composer — this session's running `/do` and the Runs it
 * admitted, each with a human title, elapsed time and state. It is a view over the session's existing records (the `/do` turn and
 * `useRunCompletion`); it owns no execution, poll or authority. It never takes input on its own: Ctrl+T moves the one input owner to it,
 * Enter opens the existing window for the selected row, Esc or Ctrl+T returns to the composer.
 */
export interface ActiveWorkLabels {
  /** Header row while the composer owns input / while the strip owns it. */
  readonly title: string; readonly focused: string;
  readonly doTitle: string; readonly planning: string; readonly waiting: string; readonly expired: string;
  readonly evaluating: string; readonly needsYou: string; readonly more: string;
  /** TESLIM-PENCERESI: an accepted task whose patch awaits the person's delivery decision (its window opens on Enter); f3 `quotaWait`: `/do` waits for the quota reset ({time}). */
  readonly deliveryWaiting?: string; readonly quotaWait?: string;
}
/** The one `/do` this session is running (one line at a time). `expiresAtMs`: its run-create approval's expiry; `untilText`: a quota wait's end. */
export type ActiveDo = Readonly<{ title: string; phase: 'planning' | 'waiting' | 'quota-wait'; sinceMs: number; expiresAtMs?: number | undefined; untilText?: string | undefined }>;
export type ActiveWorkTarget = Readonly<{ kind: 'do' }> | Readonly<{ kind: 'run'; run: RunView }> | Readonly<{ kind: 'delivery'; key: string }>;
/** A delivery waiting for the person in this session (TESLIM-PENCERESI); `sinceMs`: when this session first saw it. */
export type ActiveDelivery = Readonly<{ key: string; title: string; sinceMs: number }>;
/** `detail`: a Run's short id and its model (or task kind), between the title and the state (owner 2026-10-17). */
export type ActiveWorkItem = Readonly<{ key: string; title: string; detail?: string; state: string; role: SpanRole; elapsed: string; target: ActiveWorkTarget }>;
/** Finished Runs stay visible this many at most (most recent first): unfinished work is never hidden, finished work does not pile up. */
const FINISHED_SHOWN = 3;
/** A row's title takes at most this many cells, so id, model, state and age stay on the one line. */
const TITLE_CELLS = 48;

/** Display rank: a Run that needs the person first, then running, parked, finished. Not a policy: only the order of rows. */
function runRank(run: RunView): number {
  if (run.state.kind === 'terminal') return 3;
  if ((run.state.kind === 'parked' && ['needs-input', 'awaiting-decision'].includes(run.state.reason)) || run.tasks.some(task => task.phase === 'awaiting-decision')) return 0;
  return run.state.kind === 'parked' ? 2 : 1;
}
function runState(run: RunView, labels: ActiveWorkLabels, jobs: JobWindowLabels): Readonly<{ text: string; role: SpanRole }> {
  const rank = runRank(run);
  if (rank === 0) return { text: labels.needsYou, role: 'warning' };
  if (rank === 1 && run.tasks.some(task => task.phase === 'evaluating')) return { text: labels.evaluating, role: 'accent' };
  const text = runStateText(run, jobs), reason = parkReasonText(run, jobs);
  if (run.state.kind !== 'terminal') return { text: reason ? `${text} · ${reason}` : text, role: rank === 2 || runStatusKey(run) === 'pool-held' ? 'warning' : 'accent' };
  return { text, role: run.state.outcome === 'completed' ? 'success' : run.state.outcome === 'cancelled' ? 'muted' : 'error' };
}

/** Pure projection: rows in display order. Runs come from this session's admissions only (never another session's Runs). */
export function activeWorkItems(input: { readonly active: ActiveDo | null; readonly runs: readonly TrackedRun[]; readonly nowMs: number; readonly deliveries?: readonly ActiveDelivery[];
  readonly labels: ActiveWorkLabels; readonly jobs: JobWindowLabels; readonly duration: Pick<WorkerLineLabels, 'durationSeconds' | 'durationMinutes' | 'durationHours'> }): readonly ActiveWorkItem[] {
  const { active, labels, jobs, nowMs } = input, elapsed = (sinceMs: number) => formatDuration(Math.max(0, nowMs - sinceMs), input.duration);
  const items: ActiveWorkItem[] = [];
  if (active) {
    const left = active.expiresAtMs === undefined ? null : active.expiresAtMs - nowMs;
    const state = active.phase === 'planning' ? labels.planning : active.phase === 'quota-wait' ? fillTemplate(labels.quotaWait ?? labels.planning, { time: active.untilText ?? jobs.unknown })
      : left !== null && left <= 0 ? labels.expired : fillTemplate(labels.waiting, { remaining: left === null ? jobs.unknown : formatDuration(left, input.duration) });
    items.push({ key: 'do', title: fillTemplate(labels.doTitle, { title: active.title }), state, role: active.phase === 'planning' ? 'accent' : 'warning',
      elapsed: elapsed(active.sinceMs), target: { kind: 'do' } });
  }
  // A waiting delivery needs the person: it is listed right after the running /do, before the Runs.
  for (const delivery of labels.deliveryWaiting ? input.deliveries ?? [] : [])
    items.push({ key: `delivery:${delivery.key}`, title: delivery.title, state: labels.deliveryWaiting!, role: 'warning', elapsed: elapsed(delivery.sinceMs), target: { kind: 'delivery', key: delivery.key } });
  const sorted = [...input.runs].sort((a, b) => runRank(a.run) - runRank(b.run) || b.sinceMs - a.sinceMs);
  const runs = [...sorted.filter(row => row.run.state.kind !== 'terminal'), ...sorted.filter(row => row.run.state.kind === 'terminal').slice(0, FINISHED_SHOWN)];
  for (const { run, sinceMs } of runs) {
    const state = runState(run, labels, jobs), first = run.tasks[0], model = run.tasks.find(task => task.taskBrief?.model)?.taskBrief?.model?.modelId ?? first?.kind;
    const detail = [displayId(run.runId), ...(model ? [`${model}${run.tasks.length > 1 ? ` +${run.tasks.length - 1}` : ''}`] : [])].join(' · ');
    // Age: this session's registration of the Run (at its admission here). RunView carries no admission time; adding one is an open
    // contract decision (every RunView producer must agree), so the recorded time is not shown yet.
    items.push({ key: `run:${run.scopeId}:${run.runId}`, title: runTitle(run, jobs), detail, state: state.text, role: state.role, elapsed: elapsed(sinceMs), target: { kind: 'run', run } });
  }
  return Object.freeze(items);
}

/** The visible slice: at most `rows` lines including the header and a "+N more" line, keeping the selected row in view. */
export function activeWorkWindow(count: number, selected: number, rows: number): Readonly<{ first: number; shown: number; more: number }> {
  const room = Math.max(1, rows - 1), fits = count <= room, shown = fits ? count : Math.max(1, room - 1);
  const first = Math.min(Math.max(0, selected - shown + 1), Math.max(0, count - shown));
  return { first, shown, more: count - shown };
}

/** The strip takes a quarter of the screen at most (header and "+N more" included), and never less than header, one row and "+N more". */
const SCREEN_SHARE = 4, FLOOR_ROWS = 3;
export function activeWorkRows(screenRows: number): number { return Math.max(FLOOR_ROWS, Math.floor(screenRows / SCREEN_SHARE)); }

/** Elapsed and remaining times refresh on the session's inspection cadence (inspection.workers.heartbeatMs), never faster; a new
 * item or phase (`resetKey`) reads the clock once at that change, so a new row never shows a stale time. */
export function useActiveWorkClock(running: boolean, cadenceMs: number, resetKey = ''): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!running || cadenceMs <= 0) return undefined;
    const timer = setInterval(() => setNow(Date.now()), cadenceMs);
    return () => clearInterval(timer);
  }, [running, cadenceMs, resetKey]);
  return now;
}

/** Listens only while no window holds input. Enter on the `/do` row is the same explicit focus transfer as Ctrl+O to its open window
 * (planning or run-create card); it never answers the card. Enter on a Run row asks the host to open that Run's existing window. */
export function ActiveWorkStrip({ items, labels, rows, focused, onFocus, onOpen, collapsed = false }: { readonly items: readonly ActiveWorkItem[]; readonly labels: ActiveWorkLabels;
  readonly rows: number; readonly focused: boolean; readonly onFocus: (focused: boolean) => void; readonly onOpen: (item: ActiveWorkItem) => void;
  /** Full window (TERMINAL-SABIT-DUZEN): the list is drawn only while selected (Ctrl+T); otherwise `ActiveWorkSummary` is its one row. */
  readonly collapsed?: boolean }) {
  const [selected, setSelected] = useState(0), glyphs = useRenderGlyphs(), known = useHumanTextSecrets(), owner = useFocusOwner(), composing = owner.composing;
  const latest = useRef(items); latest.current = items;
  const index = Math.min(selected, Math.max(0, items.length - 1));
  // An emptied strip gives the input back to the composer.
  useEffect(() => { if (focused && items.length === 0) onFocus(false); }, [focused, items.length, onFocus]);
  useInput((input, key) => {
    const count = latest.current.length;
    if (key.escape || (key.ctrl && input === 't')) { onFocus(false); return; }
    if (key.upArrow) setSelected(Math.max(0, index - 1));
    else if (key.downArrow) setSelected(Math.min(count - 1, index + 1));
    else if (key.return) {
      const item = latest.current[index];
      if (!item) return;
      onFocus(false);
      if (item.target.kind === 'do') owner.focusTop(); else onOpen(item);
    }
  }, { isActive: focused && composing && items.length > 0 });
  useInput((input, key) => { if (key.ctrl && !key.meta && input === 't') onFocus(true); }, { isActive: !focused && composing && items.length > 0 });
  if (items.length === 0 || (collapsed && !focused)) return null;
  const view = activeWorkWindow(items.length, index, rows), arrow = glyphs.ascii ? '>' : '›';
  const human = (text: string): readonly Span[] => projectHumanPickerText(text, known).spans;
  // The projected (secret-masked) title is cut by cells, never the raw text, so a cut never exposes part of a masked value.
  const clipped = (parts: readonly Span[]): readonly Span[] => {
    const whole = parts.map(part => part.text).join('');
    if (cells(whole) <= TITLE_CELLS) return parts;
    let room = TITLE_CELLS - cells('…'); const out: Span[] = [];
    for (const part of parts) { if (room <= 0) break; const text = truncateEnd(part.text, room, ''); out.push({ ...part, text }); room -= cells(text); }
    return [...out, span('…')];
  };
  return <Box flexDirection="column" flexShrink={0}>
    <Text wrap="truncate-end"><SpanText spans={[span(focused ? labels.focused : labels.title, { role: focused ? 'accent' : 'muted', bold: focused })]} /></Text>
    {items.slice(view.first, view.first + view.shown).map((item, offset) => {
      const mark = focused && view.first + offset === index ? `${arrow} ` : '  ';
      return <Text key={item.key} wrap="truncate-end"><SpanText spans={[span(mark, { role: 'accent' }), ...clipped(human(item.title)).map(part => ({ ...part, bold: true })),
        ...(item.detail ? [span(` · ${item.detail}`, { role: 'muted' })] : []), span(' · '), span(item.state, { role: item.role }), span(` · ${item.elapsed}`, { role: 'muted' })]} /></Text>;
    })}
    {view.more > 0 ? <Text wrap="truncate-end"><SpanText spans={[span(fillTemplate(labels.more, { count: view.more }), { role: 'muted' })]} /></Text> : null}
  </Box>;
}

/** The strip as one row under the full-window bar: the header (it names Ctrl+T), the first item and how many more; never a decision. */
export function ActiveWorkSummary({ items, labels }: { readonly items: readonly ActiveWorkItem[]; readonly labels: ActiveWorkLabels }) {
  const known = useHumanTextSecrets(), first = items[0];
  if (!first) return null;
  const title = projectHumanPickerText(first.title, known).spans;
  return <Text wrap="truncate-end"><SpanText spans={[span(labels.title, { role: 'muted' }), span(' · '), ...title.map(part => ({ ...part, bold: true })), span(' · '),
    span(first.state, { role: first.role }), span(` · ${first.elapsed}`, { role: 'muted' }),
    ...(items.length > 1 ? [span(` · ${fillTemplate(labels.more, { count: items.length - 1 })}`, { role: 'muted' })] : [])]} /></Text>;
}
