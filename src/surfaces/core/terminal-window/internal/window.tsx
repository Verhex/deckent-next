import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, usePaste, useWindowSize, type Key } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { SpanText, cells, fillTemplate, graphemes, padSpans, plainText, sliceSpans, span, spanCells, truncateEnd, useRenderGlyphs, wrapCells, wrapSpans, type Span } from '#surfaces/core/terminal-render/index.js';
import { useDecisionQueue, useFocusOwner, useWindowLayer, useWindowLayerGuard, WindowDecideHintContext, WindowInputContext, useWindowReserve, WINDOW_PRIORITY } from './window-stack.js';
import { useWindowNote } from './window-note.js';
import { DecisionArmContext, useQuietArming } from './arming.js';
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
  return layoutWindowRows(lines, width).rows;
}

/** `layoutWindowLines` plus `starts[i]`: the first display row of body line `i` (a window keeps a revealed line in view). */
export function layoutWindowRows(lines: readonly WindowLine[], width: number): Readonly<{ rows: Span[][]; starts: readonly number[] }> {
  const labels = lines.filter(line => line.label && line.label.length).map(line => spanCells(line.label!));
  const column = labels.length ? Math.max(...labels) + 1 : 0;
  const inline = width >= LABEL_COLUMN_MIN_WIDTH && column <= Math.floor(width / 3);
  const rows: Span[][] = [], starts: number[] = [];
  for (const line of lines) {
    starts.push(rows.length);
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
  return { rows, starts };
}

export interface WindowProps {
  /** A settings window may bound its width even on a wide terminal. */
  readonly maxColumns?: number;
  /** Observation frames register no input owner; the composer keeps the keyboard. */
  readonly interactive?: boolean;
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
  /** Keys first go to the owner; `true` means handled. Unhandled scroll keys (arrows, page, first and last row) move the body. A decision
   * window delivers keys one stdin read at a time: a read that produced several key events comes with `burst` set, event by event, and the
   * owner must treat them as text at most (never a decision); the first one it does not take ends the burst and re-arms the window. */
  readonly onInput?: (input: string, key: Key, meta?: Readonly<{ burst: boolean }>) => boolean | void;
  /** Pasted text while this decision window holds the keyboard (never a decision; the owner may take it as text). */
  readonly onPaste?: (text: string) => void;
  /** Escape when the owner did not handle it: the window closes and the keyboard returns to the layer below. */
  readonly onClose?: () => void;
  /** A body line kept in view (the selected row of a list inside the body); the body scrolls to it when it changes. */
  readonly reveal?: number;
  /** A decision window: while it is on top but the composer keeps focus, it says how to reach the decision (Ctrl+O). */
  readonly decision?: boolean;
  /** Told when this window starts or stops owning the keyboard (a question arms from that moment). */
  readonly onFocusChange?: (focused: boolean) => void;
}

/**
 * A bounded modal window in the live area (owner 2026-10-07): frame, title left and status right, a body capped to the terminal's rows
 * that scrolls by keyboard, a key-hint row, widths measured in display cells. It owns input only while it is the top layer.
 */
export function Window({ title, status = [], body = [], footer, footerRows = 0, hints, position, priority = WINDOW_PRIORITY.window, onInput, onClose, reveal, interactive = true, maxColumns, decision = false,
  onFocusChange, onPaste }: WindowProps) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs(), size = useWindowSize();
  const columns = Math.min(size.columns || FALLBACK_COLUMNS, maxColumns ?? Number.MAX_SAFE_INTEGER), terminalRows = size.rows || FALLBACK_ROWS;
  const id = useId(), focused = useWindowLayer(id, interactive, priority), reserve = useWindowReserve(), reserved = reserve ?? WINDOW_RESERVED_ROWS;
  const acceptsInput = useWindowLayerGuard(id);
  const owner = useFocusOwner(), queue = useDecisionQueue(id, priority);
  useEffect(() => { onFocusChange?.(focused); }, [focused, onFocusChange]);
  // A decision (a card, a question, any approval-priority window) counts keys only after a quiet arming period from the moment it became
  // the visible input owner; earlier keys are swallowed and restart the wait (arming.ts). Fail closed: nothing reaches its owner before.
  const guarded = decision || priority >= WINDOW_PRIORITY.approval, arming = useQuietArming(focused && guarded && !queue.hidden, useContext(DecisionArmContext));
  // I-1: the slash command's one-time note sits in this window's status area while it is the focused (non-approval) window; closing it consumes the note.
  // A watch frame never takes focus (760c906e) but keeps its command's note until it closes, so it shows (and then consumes) the note too.
  const note = useWindowNote(), noteText = note && (focused || owner.top === id || !interactive) && priority !== WINDOW_PRIORITY.approval ? note.text : null;
  useEffect(() => { if (noteText === null || !note) return undefined; return () => note.consume(); }, [noteText, note]);
  // TERMINAL-SABIT R2: a decision card that appeared on its own waits behind the focused composer; its keys do nothing until Ctrl+O, so it says so.
  const decideHint = useContext(WindowDecideHintContext);
  const waitingText = decision && interactive && decideHint && owner.composerWindows && owner.top === id && owner.composing ? decideHint : null;
  const width = Math.max(1, columns - FRAME_COLUMNS);
  const { rows, starts } = layoutWindowRows(body, width);
  // Key hints wrap on a narrow terminal instead of losing their last keys.
  const hintRows = wrapCells(hints, width);
  const minimum = reserve === undefined ? MIN_BODY_ROWS : 1;
  const room = Math.max(minimum, terminalRows - reserved - FRAME_ROWS - footerRows - (hintRows.length - 1) - (noteText === null ? 0 : 1) - (waitingText === null ? 0 : 1));
  const overflow = rows.length > room, visible = overflow ? Math.max(1, room - 1) : rows.length;
  const [offset, setOffset] = useState(0);
  const revealRow = reveal === undefined ? undefined : starts[reveal];
  // Keep the revealed line in view: scroll only as far as needed, so the person's own paging stays where it was otherwise.
  useEffect(() => {
    if (revealRow === undefined) return;
    setOffset(value => revealRow < value ? revealRow : revealRow >= value + visible ? revealRow - visible + 1 : value);
  }, [revealRow, visible]);
  const latest = useRef({ total: rows.length, visible, onInput, onClose, onPaste });
  latest.current = { total: rows.length, visible, onInput, onClose, onPaste };
  const deliver = (input: string, key: Key) => {
    const current = latest.current;
    if (current.onInput?.(input, key) === true) return;
    const scroll = scrollKeyOf(key);
    if (scroll) { setOffset(value => scrollBy(value, scroll, current.total, current.visible)); return; }
    if (key.escape && current.onClose) current.onClose();
  };
  // Security review 2026-10-18 (keystroke race): Ink parses one stdin read into several key events and dispatches them synchronously, so a
  // decision window gathers the events of one read and looks at them after the read: a single event is a key press; several (an escape
  // sequence plus a letter, "text⌫y", a coalesced burst) never decide. Focus or card changes during the read drop it. Fail closed.
  const burst = useRef<{ events: Array<readonly [string, Key]>; owned: boolean } | null>(null);
  const flush = () => {
    const read = burst.current; burst.current = null;
    if (!read) return;
    if (!read.owned || !acceptsInput() || !arming.armed()) { arming.touch(); return; }
    if (read.events.length === 1) { const [input, key] = read.events[0]!; deliver(input, key); return; }
    for (const [input, key] of read.events) if (latest.current.onInput?.(input, key, { burst: true }) !== true) { arming.restart(); return; }
  };
  useInput((input, key) => {
    if (key.ctrl && input === 'o') { if (burst.current) burst.current.owned = false; return; }
    if (!guarded) { if (acceptsInput()) deliver(input, key); return; }
    if (!burst.current) { burst.current = { events: [], owned: true }; setImmediate(flush); }
    burst.current.events.push([input, key]);
    if (!acceptsInput()) burst.current.owned = false;
  }, { isActive: focused });
  // A paste consumer stays active while a decision holds the keyboard, so a paste begun in the input and finished here is still a paste
  // (Ink would otherwise deliver it as ordinary keys); pasted text never decides and restarts the arming wait.
  usePaste(text => {
    if (!acceptsInput()) return;
    if (!arming.armed()) { arming.touch(); return; }
    if (latest.current.onPaste) latest.current.onPaste(text); else arming.restart();
  }, { isActive: focused && guarded });
  const first = clampScroll(offset, rows.length, visible);
  // A decision waiting behind the shown one draws nothing (its layer and keys stay registered); the shown one says "1/3".
  if (queue.hidden) return null;
  const counted = queue.total > 1 ? `${queue.position}/${queue.total} ${plainText(status)}`.trim() : plainText(status);
  const statusText = truncateEnd(counted, Math.max(0, Math.floor(width / 2)), glyphs.ellipsis);
  const titleRoom = Math.max(1, width - (statusText ? cells(statusText) + 1 : 0));
  const titleText = plainText(title), titleFits = cells(titleText) <= titleRoom;
  return (
    <Box flexDirection="column" {...(maxColumns === undefined ? {} : { width: columns })} borderStyle={glyphs.ascii ? 'classic' : 'round'} {...(palette.windowBorder.color ? { borderColor: palette.windowBorder.color } : {})} paddingX={1} flexShrink={0}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text {...(focused ? palette.windowTitle : palette.muted)} wrap="truncate">{titleFits ? <SpanText spans={title} /> : truncateEnd(titleText, titleRoom, glyphs.ellipsis)}</Text>
        {statusText ? <Text {...palette.muted} wrap="truncate">{statusText}</Text> : null}
      </Box>
      {noteText === null ? null : <Text {...palette.warning} wrap="truncate-end">{`! ${noteText}`}</Text>}
      {rows.slice(first, first + visible).map((row, index) => <Text key={first + index} wrap="truncate">{row.length ? <SpanText spans={row} /> : ' '}</Text>)}
      {overflow ? <Text {...palette.muted} wrap="truncate">{fillTemplate(position, { from: first + 1, to: Math.min(rows.length, first + visible), total: rows.length })}</Text> : null}
      {footer ? <WindowInputContext.Provider value={acceptsInput}>{footer(focused)}</WindowInputContext.Provider> : null}
      {waitingText === null ? null : <Text {...palette.accent} wrap="truncate-end">{waitingText}</Text>}
      {hintRows.map((row, index) => <Text key={`hint:${index}`} {...palette.muted} wrap="truncate">{row}</Text>)}
    </Box>
  );
}
