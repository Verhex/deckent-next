import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, usePaste, useWindowSize, type DOMElement, type Key } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { SpanText, cells, fillTemplate, graphemes, humanRecordText, padSpans, plainText, sliceSpans, span, spanCells, truncateEnd, useHumanTextSecrets, useRenderGlyphs, wrapCells, wrapSpans, type Span } from '#surfaces/core/terminal-render/index.js';
import { useDecisionQueue, useFocusOwner, useWindowLayer, useWindowLayerGuard, WindowDecideHintContext, WindowInputContext, useWindowReserve, WINDOW_PRIORITY } from './window-stack.js';
import { useWindowNote } from './window-note.js';
import { DecisionArmContext, DecisionArmLabelsContext, useQuietArming } from './arming.js';
import { clampScroll, scrollBy, scrollKeyOf } from './scroll.js';
import { CardCopyContext, cardCopyText, cardRowRange, cardSelectionText, hyperlinkEnds, isCardCopyKey, type CardSelection } from './card-copy.js';
import { PointerContext } from './fullscreen-workline.js';
import { highlightCells } from './selection.js';

/** One logical body row: an optional field label kept in its own column (values wrap under the value column, never under the label; an
 * empty label continues the previous field in its value column).
 * `exact`: the value is a command, path, pattern or preview — it breaks at the cell limit and keeps every character (no word wrap).
 * `link`: every drawn row of the line is an OSC 8 hyperlink to this http(s) address, so a click on any piece of a wrapped link opens all of it. */
export type WindowLine = Readonly<{ label?: readonly Span[]; spans: readonly Span[]; exact?: boolean; link?: string }>;

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

/** Scrolling and highlight keys: they never decide anything, so a read made only of them may pass a decision window's burst rule. */
function navigationKey(key: Key): boolean {
  return !key.ctrl && !key.meta && !key.shift && (key.pageUp || key.pageDown || key.home || key.end || key.upArrow || key.downArrow);
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
/** How long the copy result stays in the title row's status area. */
const COPIED_MS = 4_000;

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
   * owner must treat them as text at most (never a decision); the first one it does not take ends the burst and re-arms the window. A read
   * of navigation keys only (↑↓, page, first and last row; no modifiers) comes as ordinary keys: an owner must never decide on those keys. */
  readonly onInput?: (input: string, key: Key, meta?: Readonly<{ burst: boolean }>) => boolean | void;
  /** Pasted text while this decision window holds the keyboard (never a decision; the owner may take it as text). */
  readonly onPaste?: (text: string) => void;
  /** A decision window that takes plain text from a multi-event read right now (an open reason field); without it such a read is dropped
   * whole. Fail closed: a read of unknown shape never reaches a decision owner. */
  readonly burstText?: boolean;
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
  onFocusChange, onPaste, burstText = false }: WindowProps) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs(), size = useWindowSize();
  const columns = Math.min(size.columns || FALLBACK_COLUMNS, maxColumns ?? Number.MAX_SAFE_INTEGER), terminalRows = size.rows || FALLBACK_ROWS;
  const id = useId(), focused = useWindowLayer(id, interactive, priority), reserve = useWindowReserve(), reserved = reserve ?? WINDOW_RESERVED_ROWS;
  const acceptsInput = useWindowLayerGuard(id);
  // Card copy (card-copy.ts): Ctrl+Y sends the drawn, redacted title and body; it never reaches the owner, decides or touches the arming.
  const copy = useContext(CardCopyContext), known = useHumanTextSecrets(), [copied, setCopied] = useState<string | null>(null);
  useEffect(() => { if (copied === null) return undefined; const timer = setTimeout(() => setCopied(null), COPIED_MS); return () => clearTimeout(timer); }, [copied]);
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
  const links = new Array<string | undefined>(rows.length).fill(undefined), rowLines = new Array<Readonly<{ line: number; exact: boolean; labelled: boolean }>>(rows.length);
  body.forEach((line, index) => { const end = starts[index + 1] ?? rows.length;
    if (line.link) links.fill(line.link, starts[index], end);
    rowLines.fill({ line: index, exact: line.exact === true, labelled: Boolean(line.label?.length) }, starts[index], end); });
  // A decision shows its keys only while they count: focused and armed. Until it is armed (it just appeared, or a key was ignored) the hint
  // row says so; behind the composer (Ctrl+O back to input) the "Ctrl+O to decide" line speaks instead. Keys on screen ⇔ keys count — one
  // signal for the person and for a PTY test, whatever frames the renderer skips (CI 2026-10-18).
  const armLabels = useContext(DecisionArmLabelsContext), behind = owner.top === id && owner.composing;
  const keyHints = copy && interactive ? `${hints} · ${copy.labels.hint}` : hints;
  const hintText = !guarded || !interactive || arming.shown ? keyHints : behind ? '' : arming.ignored ? armLabels.ignored : armLabels.arming;
  // Key hints wrap on a narrow terminal instead of losing their last keys.
  const hintRows = wrapCells(hintText, width);
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
  const latest = useRef({ total: rows.length, visible, onInput, onClose, onPaste, burstText, title, body, copy });
  latest.current = { total: rows.length, visible, onInput, onClose, onPaste, burstText, title, body, copy };
  const copyCard = () => {
    const { copy: writer, title: shownTitle, body: shownBody } = latest.current;
    if (!writer) return;
    const text = humanRecordText(cardCopyText(shownTitle, shownBody), known), result = writer.write(text);
    setCopied(result.ok ? fillTemplate(writer.labels.sent, { count: [...text].length })
      : result.reason === 'too-large' ? fillTemplate(writer.labels.tooLarge, { bytes: result.bytes, max: writer.maxBytes }) : writer.labels.unavailable);
  };
  const copyKey = (input: string, key: Key) => latest.current.copy !== null && interactive && isCardCopyKey(input, key);
  // Full window (the mouse is captured, so the terminal's own selection is Shift+drag): a left-button drag over the card's body rows selects
  // their drawn text and the release copies it through the same writer as Ctrl+Y (the transcript's click-and-drag, Claude Code fullscreen).
  // Only body rows are selectable (never the entry or the option rows); a pointer event is never a key, so it cannot answer or re-arm a card.
  const pointer = useContext(PointerContext), frame = useRef<DOMElement | null>(null);
  const [picked, setPickedState] = useState<CardSelection | null>(null), pickedRef = useRef(picked);
  const setPicked = (next: CardSelection | null) => { pickedRef.current = next; setPickedState(next); };
  const geometry = useRef({ first: 0, visible: 0, above: 0, hidden: false, rows: [] as string[], rowLines });
  useEffect(() => pointer?.pointer.subscribe(event => {
    const shape = geometry.current, box = screenBox(frame.current), current = pickedRef.current;
    if (shape.hidden || !box || shape.visible === 0) return;
    const index = event.row - box.top - shape.above, cell = event.column - box.left - FRAME_COLUMNS / 2;
    if (event.kind === 'press') {
      const inside = index >= 0 && index < shape.visible && event.column >= box.left && event.column < box.left + box.width;
      setPicked(inside ? { anchor: { row: shape.first + index, cell: Math.max(0, cell) }, focus: { row: shape.first + index, cell: Math.max(0, cell) }, dragging: true } : null);
      return;
    }
    if (!current?.dragging) return;
    const at = { row: shape.first + Math.min(shape.visible - 1, Math.max(0, index)), cell: index < 0 ? 0 : index >= shape.visible ? Number.MAX_SAFE_INTEGER : Math.max(0, cell) };
    if (event.kind === 'drag') { setPicked({ ...current, focus: at }); return; }
    const done = { ...current, focus: at, dragging: false };
    if (done.anchor.row === at.row && done.anchor.cell === at.cell) { setPicked(null); return; }
    setPicked(done);
    const writer = latest.current.copy, text = humanRecordText(cardSelectionText(shape.rows, shape.rowLines, done), known);
    if (!writer || !text.trim()) return;
    const result = writer.write(text);
    setCopied(result.ok ? fillTemplate(writer.labels.sent, { count: [...text].length })
      : result.reason === 'too-large' ? fillTemplate(writer.labels.tooLarge, { bytes: result.bytes, max: writer.maxBytes }) : writer.labels.unavailable);
  }), [pointer, known]);
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
    // A read of copy keys only copies and leaves the arming as it was; mixed with other keys it is one more event of a burst (never decides).
    if (read.events.every(([input, key]) => copyKey(input, key))) { if (read.owned && acceptsInput()) copyCard(); return; }
    if (!read.owned || !acceptsInput() || !arming.armed()) { arming.touch(); return; }
    if (read.events.length === 1) { const [input, key] = read.events[0]!; deliver(input, key); return; }
    // A read of navigation keys only (held PgDn, a coalesced run of arrows) moves the view or the highlight and never decides: delivered.
    if (read.events.every(([, key]) => navigationKey(key))) { for (const [input, key] of read.events) deliver(input, key); return; }
    // Several events in one read: only an owner taking plain text right now gets them (as text), and the first one it does not take ends
    // the read and re-arms; any other owner never sees such a read (security review 2026-10-18, fail-open burst handling).
    if (!latest.current.burstText) { arming.restart(); return; }
    for (const [input, key] of read.events) if (latest.current.onInput?.(input, key, { burst: true }) !== true) { arming.restart(); return; }
  };
  const begin = () => { if (!burst.current) { burst.current = { events: [], owned: true }; setImmediate(flush); } return burst.current; };
  useInput((input, key) => {
    // Any key clears a finished mouse selection (the key itself still goes on as usual).
    if (pickedRef.current && !pickedRef.current.dragging) setPicked(null);
    // A focus switch inside a read taints the whole read (it is dropped), whichever order the events came in.
    if (key.ctrl && input === 'o') { if (guarded) begin().owned = false; return; }
    if (!guarded) { if (acceptsInput()) { if (copyKey(input, key)) copyCard(); else deliver(input, key); } return; }
    const read = begin();
    read.events.push([input, key]);
    if (!acceptsInput()) read.owned = false;
  }, { isActive: focused });
  // A paste consumer stays active while a decision holds the keyboard, so a paste begun in the input and finished here is still a paste
  // (Ink would otherwise deliver it as ordinary keys); pasted text never decides and restarts the arming wait.
  usePaste(text => {
    if (!acceptsInput()) return;
    if (!arming.armed()) { arming.touch(); return; }
    if (latest.current.onPaste) latest.current.onPaste(text); else arming.restart();
  }, { isActive: focused && guarded });
  const first = clampScroll(offset, rows.length, visible);
  // Body rows start under the top border, the title row and the note row.
  geometry.current = { first, visible, above: 2 + (noteText === null ? 0 : 1), hidden: queue.hidden, rows: rows.map(row => plainText(row)), rowLines };
  // A decision waiting behind the shown one draws nothing (its layer and keys stay registered); the shown one says "1/3".
  if (queue.hidden) return null;
  const statusWords = copied ?? plainText(status), counted = queue.total > 1 ? `${queue.position}/${queue.total} ${statusWords}`.trim() : statusWords;
  const statusText = truncateEnd(counted, Math.max(0, Math.floor(width / 2)), glyphs.ellipsis);
  const titleRoom = Math.max(1, width - (statusText ? cells(statusText) + 1 : 0));
  const titleText = plainText(title), titleFits = cells(titleText) <= titleRoom;
  return (
    <Box ref={frame} flexDirection="column" {...(maxColumns === undefined ? {} : { width: columns })} borderStyle={glyphs.ascii ? 'classic' : 'round'} {...(palette.windowBorder.color ? { borderColor: palette.windowBorder.color } : {})} paddingX={1} flexShrink={0}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text {...(focused ? palette.windowTitle : palette.muted)} wrap="truncate">{titleFits ? <SpanText spans={title} /> : truncateEnd(titleText, titleRoom, glyphs.ellipsis)}</Text>
        {statusText ? <Text {...palette.muted} wrap="truncate">{statusText}</Text> : null}
      </Box>
      {noteText === null ? null : <Text {...palette.warning} wrap="truncate-end">{`! ${noteText}`}</Text>}
      {rows.slice(first, first + visible).map((row, index) => (ends => { const range = picked ? cardRowRange(picked, first + index) : null;
        return <Text key={first + index} wrap="truncate">{ends?.open}{range ? highlightCells(plainText(row) || ' ', range.start, range.end) : row.length ? <SpanText spans={row} /> : ' '}{ends?.close}</Text>; })(hyperlinkEnds(links[first + index])))}
      {overflow ? <Text {...palette.muted} wrap="truncate">{fillTemplate(position, { from: first + 1, to: Math.min(rows.length, first + visible), total: rows.length })}</Text> : null}
      {footer ? <WindowInputContext.Provider value={acceptsInput}>{footer(focused)}</WindowInputContext.Provider> : null}
      {waitingText === null ? null : <Text {...palette.accent} wrap="truncate-end">{waitingText}</Text>}
      {hintRows.map((row, index) => <Text key={`hint:${index}`} {...palette.muted} wrap="truncate">{row}</Text>)}
    </Box>
  );
}

/** The frame's place on the screen (Ink lays boxes out relative to their parent): the sum of its own and every ancestor's offset. */
function screenBox(node: DOMElement | null): Readonly<{ top: number; left: number; width: number }> | null {
  if (!node?.yogaNode) return null;
  let top = 0, left = 0;
  for (let at: DOMElement | undefined = node; at; at = at.parentNode) { const layout = at.yogaNode?.getComputedLayout(); if (layout) { top += layout.top; left += layout.left; } }
  return { top, left, width: node.yogaNode.getComputedLayout().width };
}
