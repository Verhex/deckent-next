/**
 * Ink view over the pure picker core: filter-as-you-type, paged rows, section -> key -> value levels, a scope step and blocked rows with
 * their reason. It owns the keyboard only while it is the top window layer (`windowed`) or `active`; it never applies the result.
 * `embedded` (TERM-PANEL, owner 2026-10-19): inside a window that draws the title and the key hints, the list draws neither and keeps one
 * fixed height at every level, with or without a filter and a blocked row's reason (`LIST_PICKER_EMBEDDED_CHROME_ROWS` + its page).
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { useWindowLayer, useWindowReserve, useWindowInputGuard, WINDOW_PRIORITY } from '#surfaces/core/terminal-window/index.js';
import { fillTemplate, truncateEnd, useRenderGlyphs, wrapCells, modelProviderSpans, spanStyle } from '#surfaces/core/terminal-render/index.js';
import { ARROW_PICKER_ROWS } from './arrow-picker.js';
import { PICKER_INITIAL, pickerActionOf, pickerFirstRow, pickerReduce, pickerView, type PickerOutcome, type PickerResult, type PickerState, type PickerTree, type PickerView } from './picker-core.js';

/** Words of the picker; the caller fills them from the catalog (`pickerLabels`). `{from}`, `{to}`, `{total}` in `position`; `{query}` in `filter`. */
export interface PickerLabels {
  readonly hintList: string;
  readonly hintFilter: string;
  readonly hintScope: string;
  readonly filter: string;
  readonly noMatches: string;
  readonly empty: string;
  readonly blocked: string;
  readonly position: string;
}

export const LIST_PICKER_MIN_ROWS = 3;
/** Rows around the list: breadcrumb, filter, position, reason, hints (two on a narrow terminal). */
const CHROME_ROWS = 6, FALLBACK_ROWS = 24, FALLBACK_COLUMNS = 80;
/** An embedded list's rows besides its page: one status row (filter and position) and one reason row (a long reason borrows page rows). */
export const LIST_PICKER_EMBEDDED_CHROME_ROWS = 2;
/** Border and inner padding columns of the hosting window (terminal-window's frame): an embedded list measures its rows in the window's width. */
const EMBEDDED_FRAME_COLUMNS = 4;

export function listPickerPageSize(terminalRows: number, reserved: number): number {
  return Math.max(LIST_PICKER_MIN_ROWS, Math.min(ARROW_PICKER_ROWS, terminalRows - reserved - CHROME_ROWS));
}

/** An embedded list's page: the room its window gives (`rows`), never below the minimum and never above the arrow pickers' page. */
export function embeddedPickerPageSize(rows: number): number {
  return Math.max(LIST_PICKER_MIN_ROWS, Math.min(ARROW_PICKER_ROWS, rows));
}

/** The key hints that are true for the list right now: the scope step's, the open filter's, or the list's (`list` overrides the last). */
export function pickerHints(labels: PickerLabels, state: PickerState, list = labels.hintList): string {
  return state.stage === 'scope' ? labels.hintScope : state.filter ? labels.hintFilter : list;
}

/**
 * An embedded list's fixed rows: the page shares its rows with a blocked row's reason (the reason keeps one row of its own and borrows page
 * rows down to the minimum; what still does not fit ends in an ellipsis), so the total never changes while the person moves.
 */
export function embeddedPickerLayout(view: PickerView, pageSize: number, width: number, lock: string, ellipsis: string): Readonly<{ listRows: number; reason: readonly string[] }> {
  const blocked = view.rows[view.pos]?.blocked;
  if (!blocked) return { listRows: pageSize, reason: [] };
  const wrapped = wrapCells(`${lock} ${blocked}`, width), room = 1 + Math.max(0, pageSize - LIST_PICKER_MIN_ROWS);
  const shown = wrapped.length <= room ? wrapped : [...wrapped.slice(0, room - 1), truncateEnd(wrapped.slice(room - 1).join(' '), width, ellipsis)];
  return { listRows: pageSize - (shown.length - 1), reason: shown };
}

export function ListPicker(props: {
  readonly tree: PickerTree;
  readonly labels: PickerLabels;
  readonly onResult: (result: PickerResult) => void;
  /** Called when a blocked row is chosen or an answer matches nothing; the caller may show the reason. Optional (the row already shows it). */
  readonly onOutcome?: (outcome: PickerOutcome) => void;
  /** False while another owner holds the keyboard; default true. */
  readonly active?: boolean;
  /** Register as a layer in the window stack: the picker then listens only while it is the top layer. */
  readonly windowed?: boolean;
  readonly priority?: number;
  /** Where the picker opens (T3 L4: a panel reopened after a write returns to the level it was on); default the root. */
  readonly initial?: PickerState;
  /** Every state the picker moves to (T3 L4: a panel whose scope step depends on the chosen row follows it); display only. */
  readonly onState?: (state: PickerState) => void;
  /** At most this many list rows (T3 L4: inside a window that also draws a body, the window's own room decides); never below the minimum. */
  readonly maxRows?: number;
  /** Inside a window that draws the title and the key hints (TERM-PANEL): no breadcrumb, no hint rows, one fixed height. Default false. */
  readonly embedded?: boolean;
}): ReactNode {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs(), size = useWindowSize();
  const columns = size.columns || FALLBACK_COLUMNS, terminalRows = size.rows || FALLBACK_ROWS;
  const reserved = useWindowReserve() ?? 8;
  const embedded = props.embedded ?? false;
  const pageSize = embedded ? embeddedPickerPageSize(props.maxRows ?? ARROW_PICKER_ROWS)
    : Math.max(LIST_PICKER_MIN_ROWS, Math.min(listPickerPageSize(terminalRows, reserved), props.maxRows ?? Number.MAX_SAFE_INTEGER));
  const width = Math.max(1, columns - (embedded ? EMBEDDED_FRAME_COLUMNS : 1));
  const lock = glyphs.ascii ? 'x' : '⊘', arrow = glyphs.ascii ? '>' : '›';
  const id = useId();
  const acceptsInput = useWindowInputGuard();
  const windowed = props.windowed ?? false;
  const owns = useWindowLayer(id, windowed, props.priority ?? WINDOW_PRIORITY.window);
  const closed = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const [state, setState] = useState<PickerState>(props.initial ?? PICKER_INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  const view = pickerView(props.tree, state);
  // Embedded: the page the person sees (a blocked row's reason borrows rows) is the page PgUp/PgDn move by.
  const layout = embedded ? embeddedPickerLayout(view, pageSize, width, lock, glyphs.ellipsis) : { listRows: pageSize, reason: [] as readonly string[] };
  const pageRef = useRef(layout.listRows);
  pageRef.current = layout.listRows;

  useInput((input, key) => {
    if (closed.current || !acceptsInput()) return;
    const action = pickerActionOf(input, key, stateRef.current.stage);
    if (!action) return;
    const before = stateRef.current, next = pickerReduce(latest.current.tree, before, action, { pageSize: pageRef.current });
    stateRef.current = next.state;
    setState(next.state);
    if (next.state !== before) latest.current.onState?.(next.state);
    if (next.outcome.kind === 'done') { closed.current = true; latest.current.onResult(next.outcome.result); return; }
    if (next.outcome.kind !== 'continue') latest.current.onOutcome?.(next.outcome);
  }, { isActive: (props.active ?? true) && (!windowed || owns) });

  const listRows = layout.listRows;
  const first = pickerFirstRow(view.pos, view.rows.length, listRows);
  const shown = view.rows.slice(first, first + listRows);
  const current = view.rows[view.pos];
  const filterText = view.stage === 'list' && state.filter ? truncateEnd(fillTemplate(props.labels.filter, { query: state.filter }), width, glyphs.ellipsis) : null;
  const positionText = view.rows.length > listRows
    ? fillTemplate(props.labels.position, { from: first + 1, to: Math.min(view.rows.length, first + listRows), total: view.rows.length }) : null;
  const message = view.rows.length === 0
    ? <Text {...palette.muted} wrap="truncate">{view.unfiltered === 0 ? props.labels.empty : props.labels.noMatches}</Text> : null;
  const rows = shown.map((row, offset) => {
    const at = first + offset, selected = at === view.pos;
    const text = `${selected ? '>' : ' '} ${row.blocked !== null ? lock : ' '} ${row.label}${row.section ? ` ${arrow}` : ''}${row.detail ? `  ${row.detail}` : ''}${row.blocked !== null ? `  [${props.labels.blocked}]` : ''}`;
    const tone = selected ? palette.selection : row.blocked !== null ? palette.muted : {};
    return <Text key={`${row.id}:${at}`} wrap="truncate" {...tone}>{modelProviderSpans(truncateEnd(text, width, glyphs.ellipsis), row.identity)
      .map((part, index) => <Text key={index} {...spanStyle(part, palette)}>{part.text}</Text>)}</Text>;
  });
  if (embedded) {
    // One fixed height: the page (padded), one status row (the filter, the position, or blank), the reason rows (blank when none).
    const used = shown.length + (message ? 1 : 0);
    const status = [filterText, positionText].filter((part): part is string => part !== null).join(' · ');
    return (
      <Box flexDirection="column">
        {message}
        {rows}
        {Array.from({ length: Math.max(0, listRows - used) }, (_, index) => <Text key={`pad:${index}`}> </Text>)}
        <Text {...palette.muted} wrap="truncate">{status ? truncateEnd(status, width, glyphs.ellipsis) : ' '}</Text>
        {layout.reason.length
          ? layout.reason.map((row, index) => <Text key={`reason:${index}`} {...palette.warning} wrap="truncate">{row}</Text>)
          : <Text> </Text>}
      </Box>
    );
  }
  const hints = pickerHints(props.labels, state);
  const hintRows = wrapCells(hints, width);
  return (
    <Box flexDirection="column">
      <Text {...palette.windowTitle} wrap="truncate">{truncateEnd(view.crumbs.join(` ${arrow} `), width, glyphs.ellipsis)}</Text>
      {filterText !== null ? <Text {...palette.muted} wrap="truncate">{filterText}</Text> : null}
      {message}
      {rows}
      {positionText !== null ? <Text {...palette.muted} wrap="truncate">{positionText}</Text> : null}
      {current?.blocked ? <Text {...palette.warning} wrap="wrap">{`${lock} ${current.blocked}`}</Text> : null}
      {hintRows.map((row, index) => <Text key={`hint:${index}`} {...palette.muted} wrap="truncate">{row}</Text>)}
    </Box>
  );
}
