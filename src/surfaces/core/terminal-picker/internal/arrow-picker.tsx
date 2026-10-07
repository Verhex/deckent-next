/**
 * Arrow-key list for a submitted command (arg-less `/resume` and `/approvals`). Same keys as the slash palette:
 * Up/Down move the highlight (wrapping), Enter commits the highlighted row, Esc or Ctrl+C closes it. The row Enter
 * commits is `pickerChoice(selected)` — passing the first row instead fails the Down-then-Enter tests.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { pickerChoice, pickerFirstRow, movePicker } from './picker-core.js';
import { truncateEnd, useRenderGlyphs, SpanText, sliceSpans, span, type Span } from '#surfaces/core/terminal-render/index.js';

export const ARROW_PICKER_ROWS = 6;

export function ArrowPicker(props: {
  readonly rows: readonly string[];
  /** Optional already projected display spans; selection still binds the original row index. */
  readonly styledRows?: readonly (readonly Span[])[];
  readonly details?: readonly (string | undefined)[];
  readonly onSelect: (index: number) => void;
  readonly onCancel: () => void;
  /** False while another window owns the keyboard (the window stack); default true. */
  readonly active?: boolean;
}): ReactNode {
  const palette = useWorklinePalette();
  const glyphs = useRenderGlyphs();
  const { columns } = useWindowSize();
  const selectedRef = useRef(0);
  const closed = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const [generation, setGeneration] = useState(0);

  useInput((input, key) => {
    if (closed.current) return;
    const count = latest.current.rows.length;
    const plain = !key.ctrl && !key.meta && !key.shift;
    if (plain && (key.upArrow || key.downArrow)) {
      selectedRef.current = movePicker(selectedRef.current, count, key.upArrow ? 'up' : 'down');
      setGeneration(value => value + 1);
      return;
    }
    if (plain && key.return) {
      closed.current = true;
      latest.current.onSelect(pickerChoice(selectedRef.current, count));
      return;
    }
    if (key.escape || (key.ctrl && input === 'c' && !key.meta)) {
      closed.current = true;
      latest.current.onCancel();
    }
  }, { isActive: props.active ?? true });

  const index = pickerChoice(selectedRef.current, props.rows.length);
  const first = pickerFirstRow(index, props.rows.length, ARROW_PICKER_ROWS);
  const width = Math.max(1, (columns || 80) - 1);
  void generation;
  return (
    <Box flexDirection="column">
      {props.rows.slice(first, first + ARROW_PICKER_ROWS).map((row, offset) => {
        const at = first + offset;
        const marked = `${at === index ? '>' : ' '} ${row}`;
        const fitted = truncateEnd(marked, width, glyphs.ellipsis);
        const projected = props.styledRows?.[at];
        const visible = fitted.endsWith(glyphs.ellipsis) && fitted !== marked ? fitted.length - glyphs.ellipsis.length : fitted.length;
        return (
          <Text key={at} wrap="truncate" {...(at === index ? palette.selection : {})}>
            {projected ? <SpanText spans={[...sliceSpans([span(`${at === index ? '>' : ' '} `), ...projected], 0, visible),
              ...(visible < fitted.length ? [span(glyphs.ellipsis)] : [])]} /> : fitted}
          </Text>
        );
      })}
      {props.details?.[index] ? <Text {...palette.warning} wrap="wrap">{props.details[index]}</Text> : null}
      {props.rows.length > first + ARROW_PICKER_ROWS
        ? <Text {...palette.muted} wrap="truncate">{`  +${props.rows.length - first - ARROW_PICKER_ROWS}`}</Text> : null}
    </Box>
  );
}
