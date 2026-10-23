/**
 * Arrow-key list for a submitted command (arg-less `/resume` and `/approvals`). Same keys as the slash palette:
 * Up/Down move the highlight (wrapping), Enter commits the highlighted row, Esc or Ctrl+C closes it. The row Enter
 * commits is `pickerChoice(selected)` — passing the first row instead fails the Down-then-Enter tests.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { pickerChoice, pickerFirstRow, movePicker } from './picker-core.js';
import { useWindowInputGuard } from '#surfaces/core/terminal-window/index.js';
import { truncateEnd, useRenderGlyphs, SpanText, sliceSpans, span, type Span } from '#surfaces/core/terminal-render/index.js';

export const ARROW_PICKER_ROWS = 6;
const FALLBACK_COLUMNS = 80;

// eslint-disable-next-line no-control-regex -- typed filter text takes no control characters.
const FILTER_CONTROL = /[\u0000-\u001f\u007f]/gu;

/** The original indexes of the rows whose text contains `filter` (case-insensitive); an empty filter keeps every row. */
export function filterPickerRows(rows: readonly string[], filter: string): readonly number[] {
  const needle = filter.toLowerCase();
  return rows.flatMap((row, index) => !needle || row.toLowerCase().includes(needle) ? [index] : []);
}

export function ArrowPicker(props: {
  readonly maxColumns?: number;
  readonly rows: readonly string[];
  /** Optional already projected display spans; selection still binds the original row index. */
  readonly styledRows?: readonly (readonly Span[])[];
  readonly details?: readonly (string | undefined)[];
  readonly onSelect: (index: number) => void;
  readonly onCancel: () => void;
  /** False while another window owns the keyboard (the window stack); default true. */
  readonly active?: boolean;
  /** T5: typing narrows the list (case-insensitive substring of the row text) and Backspace widens it again; Enter still commits the ORIGINAL row index.
   * `prompt(text)` is the always-present filter row; `none` is shown when nothing matches. Absent: typed characters are ignored, as before. */
  readonly filter?: { readonly prompt: (text: string) => string; readonly none: string };
}): ReactNode {
  const palette = useWorklinePalette();
  const acceptsInput = useWindowInputGuard();
  const glyphs = useRenderGlyphs();
  const { columns } = useWindowSize();
  const selectedRef = useRef(0), filterRef = useRef('');
  const closed = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const [generation, setGeneration] = useState(0);

  useInput((input, key) => {
    if (closed.current || !acceptsInput()) return;
    const shown = filterPickerRows(latest.current.rows, latest.current.filter ? filterRef.current : '');
    const count = shown.length;
    const plain = !key.ctrl && !key.meta && !key.shift;
    if (latest.current.filter && !key.ctrl && !key.meta && !key.escape && !key.return && !key.upArrow && !key.downArrow && !key.tab) {
      const typed = key.backspace || key.delete ? filterRef.current.slice(0, -1) : filterRef.current + input.replace(FILTER_CONTROL, '');
      if (typed !== filterRef.current) { filterRef.current = typed; selectedRef.current = 0; setGeneration(value => value + 1); }
      return;
    }
    if (plain && (key.upArrow || key.downArrow)) {
      selectedRef.current = movePicker(selectedRef.current, count, key.upArrow ? 'up' : 'down');
      setGeneration(value => value + 1);
      return;
    }
    if (plain && key.return) {
      if (count === 0) return;
      closed.current = true;
      latest.current.onSelect(shown[pickerChoice(selectedRef.current, count)]!);
      return;
    }
    if (key.escape || (key.ctrl && input === 'c' && !key.meta)) {
      closed.current = true;
      latest.current.onCancel();
    }
  }, { isActive: props.active ?? true });

  const filterText = props.filter ? filterRef.current : '';
  const shown = filterPickerRows(props.rows, filterText);
  const index = pickerChoice(selectedRef.current, shown.length);
  const first = pickerFirstRow(index, shown.length, ARROW_PICKER_ROWS);
  const width = Math.max(1, Math.min(columns || FALLBACK_COLUMNS, props.maxColumns ?? Number.MAX_SAFE_INTEGER) - 1);
  void generation;
  return (
    <Box flexDirection="column">
      {props.filter ? <Text {...palette.muted} wrap="truncate">{truncateEnd(props.filter.prompt(filterText), width, glyphs.ellipsis)}</Text> : null}
      {props.filter && shown.length === 0 ? <Text {...palette.warning} wrap="truncate">{props.filter.none}</Text> : null}
      {shown.slice(first, first + ARROW_PICKER_ROWS).map((original, offset) => {
        const at = first + offset, row = props.rows[original]!;
        const marked = `${at === index ? '>' : ' '} ${row}`;
        const fitted = truncateEnd(marked, width, glyphs.ellipsis);
        const projected = props.styledRows?.[original];
        const visible = fitted.endsWith(glyphs.ellipsis) && fitted !== marked ? fitted.length - glyphs.ellipsis.length : fitted.length;
        return (
          <Text key={original} wrap="truncate" {...(at === index ? palette.selection : {})}>
            {projected ? <SpanText spans={[...sliceSpans([span(`${at === index ? '>' : ' '} `), ...projected], 0, visible),
              ...(visible < fitted.length ? [span(glyphs.ellipsis)] : [])]} /> : fitted}
          </Text>
        );
      })}
      {shown.length > 0 && props.details?.[shown[index]!] ? <Text {...palette.warning} wrap="wrap">{props.details[shown[index]!]}</Text> : null}
      {shown.length > first + ARROW_PICKER_ROWS
        ? <Text {...palette.muted} wrap="truncate">{`  +${shown.length - first - ARROW_PICKER_ROWS}`}</Text> : null}
    </Box>
  );
}
