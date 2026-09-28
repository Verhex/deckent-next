/**
 * Arrow-key list for a submitted command (arg-less `/resume` and `/approvals`). Same keys as the slash palette:
 * Up/Down move the highlight (wrapping), Enter commits the highlighted row, Esc or Ctrl+C closes it. The row Enter
 * commits is `pickerChoice(selected)` — passing the first row instead fails the Down-then-Enter tests.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { truncateEnd, useRenderGlyphs } from '#surfaces/core/terminal-render/index.js';

export const ARROW_PICKER_ROWS = 6;

/** Index Enter commits. `count <= 0` has no row; a negative modulo wraps to the end. */
export function pickerChoice(selected: number, count: number): number {
  if (count <= 0) return 0;
  const index = selected % count;
  return index < 0 ? index + count : index;
}

export function movePicker(selected: number, count: number, direction: 'up' | 'down'): number {
  if (count <= 0) return 0;
  return pickerChoice(selected + (direction === 'up' ? -1 : 1), count);
}

export function ArrowPicker(props: {
  readonly rows: readonly string[];
  readonly onSelect: (index: number) => void;
  readonly onCancel: () => void;
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
  });

  const index = pickerChoice(selectedRef.current, props.rows.length);
  const first = Math.max(0, Math.min(index - ARROW_PICKER_ROWS + 1, props.rows.length - ARROW_PICKER_ROWS));
  const width = Math.max(1, (columns || 80) - 1);
  void generation;
  return (
    <Box flexDirection="column">
      {props.rows.slice(first, first + ARROW_PICKER_ROWS).map((row, offset) => {
        const at = first + offset;
        const marked = `${at === index ? '>' : ' '} ${row}`;
        return (
          <Text key={at} wrap="truncate" {...(at === index ? palette.accent : {})}>
            {truncateEnd(marked, width, glyphs.ellipsis)}
          </Text>
        );
      })}
      {props.rows.length > first + ARROW_PICKER_ROWS
        ? <Text {...palette.muted} wrap="truncate">{`  +${props.rows.length - first - ARROW_PICKER_ROWS}`}</Text> : null}
    </Box>
  );
}
