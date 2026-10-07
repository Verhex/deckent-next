/**
 * Ink view over the pure picker core: filter-as-you-type, paged rows, section -> key -> value levels, a scope step and blocked rows with
 * their reason. It owns the keyboard only while it is the top window layer (`windowed`) or `active`; it never applies the result.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { useWindowLayer, useWindowReserve, WINDOW_PRIORITY } from '#surfaces/core/terminal-window/index.js';
import { fillTemplate, truncateEnd, useRenderGlyphs, wrapCells } from '#surfaces/core/terminal-render/index.js';
import { ARROW_PICKER_ROWS } from './arrow-picker.js';
import { PICKER_INITIAL, pickerActionOf, pickerFirstRow, pickerReduce, pickerView, type PickerOutcome, type PickerResult, type PickerState, type PickerTree } from './picker-core.js';

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

export function listPickerPageSize(terminalRows: number, reserved: number): number {
  return Math.max(LIST_PICKER_MIN_ROWS, Math.min(ARROW_PICKER_ROWS, terminalRows - reserved - CHROME_ROWS));
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
}): ReactNode {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs(), size = useWindowSize();
  const columns = size.columns || FALLBACK_COLUMNS, terminalRows = size.rows || FALLBACK_ROWS;
  const reserved = useWindowReserve() ?? 8;
  const pageSize = listPickerPageSize(terminalRows, reserved);
  const id = useId();
  const windowed = props.windowed ?? false;
  const owns = useWindowLayer(id, windowed, props.priority ?? WINDOW_PRIORITY.window);
  const closed = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const [state, setState] = useState<PickerState>(PICKER_INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;

  useInput((input, key) => {
    if (closed.current) return;
    const action = pickerActionOf(input, key, stateRef.current.stage);
    if (!action) return;
    const next = pickerReduce(latest.current.tree, stateRef.current, action, { pageSize });
    stateRef.current = next.state;
    setState(next.state);
    if (next.outcome.kind === 'done') { closed.current = true; latest.current.onResult(next.outcome.result); return; }
    if (next.outcome.kind !== 'continue') latest.current.onOutcome?.(next.outcome);
  }, { isActive: (props.active ?? true) && (!windowed || owns) });

  const view = pickerView(props.tree, state);
  const width = Math.max(1, columns - 1);
  const first = pickerFirstRow(view.pos, view.rows.length, pageSize);
  const shown = view.rows.slice(first, first + pageSize);
  const lock = glyphs.ascii ? 'x' : '⊘', arrow = glyphs.ascii ? '>' : '›';
  const current = view.rows[view.pos];
  const hints = view.stage === 'scope' ? props.labels.hintScope : state.filter ? props.labels.hintFilter : props.labels.hintList;
  const hintRows = wrapCells(hints, width);
  return (
    <Box flexDirection="column">
      <Text {...palette.windowTitle} wrap="truncate">{truncateEnd(view.crumbs.join(` ${arrow} `), width, glyphs.ellipsis)}</Text>
      {view.stage === 'list' && state.filter
        ? <Text {...palette.muted} wrap="truncate">{truncateEnd(fillTemplate(props.labels.filter, { query: state.filter }), width, glyphs.ellipsis)}</Text> : null}
      {view.rows.length === 0
        ? <Text {...palette.muted} wrap="truncate">{view.unfiltered === 0 ? props.labels.empty : props.labels.noMatches}</Text> : null}
      {shown.map((row, offset) => {
        const at = first + offset, selected = at === view.pos;
        const text = `${selected ? '>' : ' '} ${row.blocked !== null ? lock : ' '} ${row.label}${row.section ? ` ${arrow}` : ''}${row.detail ? `  ${row.detail}` : ''}${row.blocked !== null ? `  [${props.labels.blocked}]` : ''}`;
        const tone = selected ? palette.selection : row.blocked !== null ? palette.muted : {};
        return <Text key={`${row.id}:${at}`} wrap="truncate" {...tone}>{truncateEnd(text, width, glyphs.ellipsis)}</Text>;
      })}
      {view.rows.length > pageSize
        ? <Text {...palette.muted} wrap="truncate">{fillTemplate(props.labels.position, { from: first + 1, to: Math.min(view.rows.length, first + pageSize), total: view.rows.length })}</Text> : null}
      {current?.blocked ? <Text {...palette.warning} wrap="wrap">{`${lock} ${current.blocked}`}</Text> : null}
      {hintRows.map((row, index) => <Text key={`hint:${index}`} {...palette.muted} wrap="truncate">{row}</Text>)}
    </Box>
  );
}
