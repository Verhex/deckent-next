import { useId, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useWindowSize, type Key } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { SpanText, cells, fillTemplate, graphemes, padSpans, plainText, sliceSpans, span, spanCells, truncateEnd, useRenderGlyphs, wrapCells, wrapSpans, type Span } from '#surfaces/core/terminal-render/index.js';
import { useWindowLayer, WINDOW_PRIORITY } from './window-stack.js';
import { clampScroll, scrollBy, scrollKeyOf } from './scroll.js';

/** One logical body row: an optional field label kept in its own column (values wrap under the value column, never under the label; an
 * empty label continues the previous field in its value column).
 * `exact`: the value is a command, path, pattern or preview — it breaks at the cell limit and keeps every character (no word wrap). */
export type WindowLine = Readonly<{ label?: readonly Span[]; spans: readonly Span[]; exact?: boolean }>;

/** Breaks spans at exactly `width` cells, keeping every character (whitespace included) in order. */
export function hardWrapSpans(spans: readonly Span[], width: number): Span[][] {
  const limit = Math.max(1, width), rows: Span[][] = [];
  let start = 0, offset = 0, used = 0;
  for (const cluster of graphemes(plainText(spans))) {
    const size = cells(cluster);
    if (used + size > limit && offset > start) { rows.push(sliceSpans(spans, start, offset)); start = offset; used = 0; }
    offset += cluster.length; used += size;
  }
  rows.push(sliceSpans(spans, start, offset));
  return rows;
}

/** Frame rows around the body: two border rows, the title row and the key-hint row. */
const FRAME_ROWS = 4;
/** Border and inner padding columns on each side together. */
const FRAME_COLUMNS = 4;
/** Rows a window leaves for the rest of the live area: the live answer line, banner, status strip, the framed composer and its hint line. */
export const WINDOW_RESERVED_ROWS = 8;
/** The smallest body a window keeps on a tiny terminal (it then scrolls a row at a time). */
const MIN_BODY_ROWS = 3;
/** Below this inner width labels go on their own row instead of a column (a 40-column terminal). */
const LABEL_COLUMN_MIN_WIDTH = 48;
const FALLBACK_COLUMNS = 80, FALLBACK_ROWS = 24;

/** Lays out body lines into display rows of at most `width` cells: labelled rows align their values in one column. */
export function layoutWindowLines(lines: readonly WindowLine[], width: number): Span[][] {
  const labels = lines.filter(line => line.label && line.label.length).map(line => spanCells(line.label!));
  const column = labels.length ? Math.max(...labels) + 1 : 0;
  const inline = width >= LABEL_COLUMN_MIN_WIDTH && column <= Math.floor(width / 3);
  const rows: Span[][] = [];
  for (const line of lines) {
    const wrap = line.exact ? hardWrapSpans : wrapSpans;
    if (!line.label || !line.label.length) { rows.push(...(line.spans.length ? wrap(line.spans, width) : [[]])); continue; }
    if (!inline) {
      if (plainText(line.label)) rows.push(...wrapSpans(line.label, width));
      rows.push(...wrap(line.spans, Math.max(1, width - 2)).map(row => [span('  '), ...row]));
      continue;
    }
    const wrapped = wrap(line.spans, Math.max(1, width - column));
    wrapped.forEach((row, index) => rows.push([...(index === 0 ? padSpans(line.label!, column) : [span(' '.repeat(column))]), ...row]));
  }
  return rows;
}

export interface WindowProps {
  readonly title: readonly Span[];
  /** Right side of the title row (a countdown, a count); shortened before the title is. */
  readonly status?: readonly Span[];
  readonly body?: readonly WindowLine[];
  /** Content under the body that does not scroll (a picker, a reason field); `rows` counts its height for the cap. */
  readonly footer?: (focused: boolean) => ReactNode;
  readonly footerRows?: number;
  readonly hints: string;
  /** `{from}`, `{to}`, `{total}`: shown when the body does not fit. */
  readonly position: string;
  readonly priority?: number;
  /** Keys first go to the owner; `true` means handled. Unhandled scroll keys (arrows, page, first and last row) move the body. */
  readonly onInput?: (input: string, key: Key) => boolean | void;
  /** Escape when the owner did not handle it: the window closes and the keyboard returns to the layer below. */
  readonly onClose?: () => void;
}

/**
 * A bounded modal window in the live area (owner 2026-10-07): frame, title left and status right, a body capped to the terminal's rows
 * that scrolls by keyboard, a key-hint row, widths measured in display cells. It owns input only while it is the top layer.
 */
export function Window({ title, status = [], body = [], footer, footerRows = 0, hints, position, priority = WINDOW_PRIORITY.window, onInput, onClose }: WindowProps) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs(), size = useWindowSize();
  const columns = size.columns || FALLBACK_COLUMNS, terminalRows = size.rows || FALLBACK_ROWS;
  const id = useId(), focused = useWindowLayer(id, true, priority);
  const width = Math.max(1, columns - FRAME_COLUMNS);
  const rows = layoutWindowLines(body, width);
  // Key hints wrap on a narrow terminal instead of losing their last keys.
  const hintRows = wrapCells(hints, width);
  const room = Math.max(MIN_BODY_ROWS, terminalRows - WINDOW_RESERVED_ROWS - FRAME_ROWS - footerRows - (hintRows.length - 1));
  const overflow = rows.length > room, visible = overflow ? Math.max(1, room - 1) : rows.length;
  const [offset, setOffset] = useState(0);
  const latest = useRef({ total: rows.length, visible, onInput, onClose });
  latest.current = { total: rows.length, visible, onInput, onClose };
  useInput((input, key) => {
    const current = latest.current;
    if (current.onInput?.(input, key) === true) return;
    const scroll = scrollKeyOf(key);
    if (scroll) { setOffset(value => scrollBy(value, scroll, current.total, current.visible)); return; }
    if (key.escape && current.onClose) current.onClose();
  }, { isActive: focused });
  const first = clampScroll(offset, rows.length, visible);
  const statusText = truncateEnd(plainText(status), Math.max(0, Math.floor(width / 2)), glyphs.ellipsis);
  const titleRoom = Math.max(1, width - (statusText ? cells(statusText) + 1 : 0));
  const titleText = plainText(title), titleFits = cells(titleText) <= titleRoom;
  return (
    <Box flexDirection="column" borderStyle={glyphs.ascii ? 'classic' : 'round'} {...(palette.accent.color ? { borderColor: palette.accent.color } : {})} paddingX={1} flexShrink={0}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text {...palette.strong} wrap="truncate">{titleFits ? <SpanText spans={title} /> : truncateEnd(titleText, titleRoom, glyphs.ellipsis)}</Text>
        {statusText ? <Text {...palette.muted} wrap="truncate">{statusText}</Text> : null}
      </Box>
      {rows.slice(first, first + visible).map((row, index) => <Text key={first + index} wrap="truncate">{row.length ? <SpanText spans={row} /> : ' '}</Text>)}
      {overflow ? <Text {...palette.muted} wrap="truncate">{fillTemplate(position, { from: first + 1, to: Math.min(rows.length, first + visible), total: rows.length })}</Text> : null}
      {footer ? footer(focused) : null}
      {hintRows.map((row, index) => <Text key={`hint:${index}`} {...palette.muted} wrap="truncate">{row}</Text>)}
    </Box>
  );
}
