import { stripVTControlCharacters } from 'node:util';
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Box, Text, Transform, useInput, useIsScreenReaderEnabled, usePaste, useWindowSize, type DOMElement, type Key } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit-ink/index.js';
import { cells, fillTemplate, graphemes, humanRecordText, padSpans, plainText, sliceSpans, span, spanCells, truncateEnd, wrapCells, wrapSpans, type Span, SpanText, useHumanTextSecrets, useRenderGlyphs } from '#surfaces/core/terminal-render-ink/index.js';
import { useDecisionQueue, useFocusOwner, useWindowLayer, useWindowLayerGuard, WindowDecideHintContext, WindowInputContext, useWindowReserve, WINDOW_PRIORITY } from './window-stack.js';
import { useWindowNote } from './window-note.js';
import { DecisionArmContext, DecisionArmLabelsContext, QueuedListOpeningContext, useQuietArming } from './arming.js';
import { clampScroll, scrollBy, scrollKeyOf } from './scroll.js';
import { CardCopyContext, CardCopyOptionsContext, cardCopyText, cardRowRange, cardSelectionText, hyperlinkEnds, isCardCopyKey, type CardSelection } from './card-copy.js';
import { PointerContext } from './fullscreen-workline.js';
import { highlightCells } from './selection.js';

/** A host may identify a specific Window so a person can focus it from its matching work row. */
export const WindowLayerIdContext = createContext<string | undefined>(undefined);

/** One logical body row: an optional field label kept in its own column (values wrap under the value column, never under the label; an
 * empty label continues the previous field in its value column).
 * `exact`: the value is a command, path, pattern or preview — it breaks at the cell limit and keeps every character (no word wrap).
 * `link`: every drawn row of the line is an OSC 8 hyperlink to this http(s) address, so a click on any piece of a wrapped link opens all of it. */
type DrawnRow = Readonly<{ text: string; precedingText: string }>;
type ReportRows = (rows: readonly DrawnRow[]) => void;
export type WindowLine = Readonly<{ label?: readonly Span[]; spans: readonly Span[]; exact?: boolean; link?: string;
  /** Report the visible rows of this logical line together, from one output frame. */
  onDrawn?: ReportRows | undefined }>;

export function createWindowDrawing() {
  let pending = new Map<ReportRows, DrawnRow[]>();
  return {
    add(report: ReportRows, row: DrawnRow) {
      const rows = pending.get(report);
      if (rows) rows.push(row); else pending.set(report, [row]);
    },
    finish(presented: boolean) {
      if (!pending.size) return;
      const frame = pending;
      pending = new Map();
      if (presented) for (const [report, rows] of frame) report(rows);
    },
  };
}
export const WindowDrawingContext = createContext<ReturnType<typeof createWindowDrawing> | null>(null);

export function DrawnText({ children, text, precedingText = '', onDrawn }: {
  readonly children: ReactNode; readonly text: string; readonly precedingText?: string; readonly onDrawn: ReportRows;
}) {
  const screenReader = useIsScreenReaderEnabled(), drawing = useContext(WindowDrawingContext);
  const report = (line: string) => {
    const row = { text: stripVTControlCharacters(line), precedingText };
    if (drawing) drawing.add(onDrawn, row); else onDrawn([row]);
  };
  // Ink visits Box state after building its accessible label. Returning false adds no state announcement.
  // A nested Transform would also run during Yoga measurement.
  return screenReader
    ? <Box aria-label={text} aria-state={{ get selected() { report(text); return false; } }} />
    : <Transform transform={line => { report(line); return line; }}>{children}</Transform>;
}

/** Breaks spans at exactly `width` cells, keeping every character (whitespace included) in order. */
function hardWrapSpans(spans: readonly Span[], width: number): Span[][] {
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

/** Printable text, including spaces; control chords and terminal key sequences are never text. */
function printable(input: string, key: Key): boolean {
  return !key.ctrl && !key.meta && !key.escape && !key.tab && /[^\p{C}]/u.test(input);
}

/** Owner 109: a read that is exactly one printable character (never a paste, a multi-key or an ambiguous read). */
function loneKey(events: ReadonlyArray<readonly [string, Key]>): string | null {
  const [input, key] = events[0]!;
  return events.length === 1 && printable(input, key) && [...input].length === 1 ? input : null;
}

/**
 * Text that reached a choice-only card (owner 107–109). `typed`: every later letter and digit is text until a plain Enter or a navigation
 * key. `early`: the one key swallowed while the card was opening; only its own repeat may follow as a first key, any other letter is text
 * and a plain Enter chooses nothing. Only those keys clear it: a focus round trip, a re-arm or a new question keep both (never less strict).
 */
function useCardText(burstText: boolean) {
  const typed = useRef(false), early = useRef<string | null>(null), [hint, setHint] = useState<'early' | 'text' | 'unchosen' | null>(null);
  const set = (value: boolean, unchosen = false) => { early.current = null; typed.current = value; setHint(value ? 'text' : unchosen ? 'unchosen' : null); };
  useEffect(() => { if (burstText) set(false); }, [burstText]);
  return { typed, early, hint, set, remember: (input: string) => { early.current = input; setHint('early'); },
    /** Drops the "nothing was chosen" note once it is stale; text and a remembered key stay. */
    settle: () => { if (!typed.current && early.current === null) setHint(null); } };
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
function layoutWindowRows(lines: readonly WindowLine[], width: number): Readonly<{ rows: Span[][]; starts: readonly number[] }> {
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

interface WindowProps {
  /** A settings window may bound its width even on a wide terminal. */
  readonly maxColumns?: number;
  /** Observation frames register no input owner; the composer keeps the keyboard. */
  readonly interactive?: boolean;
  readonly title: readonly Span[];
  /** Right side of the title row (a countdown, a count); shortened before the title is. */
  readonly status?: readonly Span[];
  readonly body?: readonly WindowLine[];
  /** Content under the body with the same column limit as the body; footerRows reserves its height. */
  readonly footer?: (focused: boolean, contentColumns: number) => ReactNode;
  readonly footerRows?: number;
  /** Visible labels of a custom option footer; entries must never be included. Shared pickers register their own labels. */
  readonly copyOptions?: readonly string[];
  readonly hints: string;
  /** A short decision explanation kept in view as the body scrolls. */
  readonly notice?: string | undefined;
  readonly scrollHint?: string | undefined;
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
  /** A new question in the same frame re-arms, retaining text swallowed while the last answer was being applied. */
  readonly inputRevision?: number;
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
export function Window({ title, status = [], body = [], footer, footerRows = 0, hints, notice, scrollHint, position, priority = WINDOW_PRIORITY.window, onInput, onClose, reveal, interactive = true, maxColumns, decision = false,
  onFocusChange, onPaste, inputRevision, burstText = false, copyOptions = [] }: WindowProps) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs(), size = useWindowSize();
  const columns = Math.min(size.columns || FALLBACK_COLUMNS, maxColumns ?? Number.MAX_SAFE_INTEGER), terminalRows = size.rows || FALLBACK_ROWS;
  const instanceId = useId(), id = useContext(WindowLayerIdContext) ?? instanceId;
  const focused = useWindowLayer(id, interactive, priority), reserve = useWindowReserve(), reserved = reserve ?? WINDOW_RESERVED_ROWS;
  const acceptsInput = useWindowLayerGuard(id);
  // Card copy (card-copy.ts): Ctrl+Y sends the drawn, redacted title, body and option labels; it never reaches the owner, decides or touches the arming.
  const optionLabels = useRef(new Map<string, readonly string[]>());
  const copy = useContext(CardCopyContext), known = useHumanTextSecrets(), [copied, setCopied] = useState<string | null>(null);
  useEffect(() => { if (copied === null) return undefined; const timer = setTimeout(() => setCopied(null), COPIED_MS); return () => clearTimeout(timer); }, [copied]);
  const owner = useFocusOwner(), queue = useDecisionQueue(id, priority);
  useEffect(() => { onFocusChange?.(focused); }, [focused, onFocusChange]);
  // A decision (a card, a question, any approval-priority window) counts keys only after a quiet arming period from the moment it became
  // the visible input owner; earlier keys are swallowed and restart the wait (arming.ts). Fail closed: nothing reaches its owner before.
  const guarded = decision || priority >= WINDOW_PRIORITY.approval, queuedOpening = useContext(QueuedListOpeningContext), queuedList = queuedOpening && !guarded;
  // A queued catalog entering its decision stage must arm anew, even though it already owned the keyboard.
  const arming = useQuietArming(focused && (guarded || queuedList) && !queue.hidden, useContext(DecisionArmContext), queuedOpening ? `${guarded}:${inputRevision}` : inputRevision);
  const acceptsListInput = () => {
    if (!acceptsInput()) return false;
    if (queuedList && !arming.armed()) { arming.touch(); return false; }
    return true;
  };
  // Owner 108: once text reaches a choice-only card, later letters/digits are text too; only Enter or navigation ends it.
  const typing = useCardText(burstText);
  useEffect(typing.settle, [arming.shown, focused, inputRevision]);
  // A window that stops being a decision (a list leaving its confirm stage) forgets typed text: its next confirm stage starts clean and arms anew.
  useEffect(() => { if (!guarded) typing.set(false); }, [guarded]);
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
  // A decision shows its choice keys only while they count: focused and armed. Until it is armed (it just appeared, or a key was ignored) the hint
  // row says so; behind the composer (Ctrl+O back to input) the "Ctrl+O to decide" line speaks instead. Keys on screen ⇔ keys count — one
  // signal for the person and for a PTY test, whatever frames the renderer skips (CI 2026-10-18). Typed-text exit instructions appear only once their keys count.
  const armLabels = useContext(DecisionArmLabelsContext), behind = owner.top === id && owner.composing;
  const keyHints = copy && interactive ? `${hints} · ${copy.labels.hint}` : hints;
  const armedHints = burstText || typing.hint === null ? keyHints : typing.hint === 'early' ? armLabels.ignored : typing.hint === 'text' ? armLabels.typedText : `${armLabels.unchosen} ${keyHints}`;
  const hintText = queuedList && interactive && !arming.shown ? armLabels.arming : !guarded || !interactive ? keyHints : behind ? '' : arming.shown ? armedHints : armLabels.arming;
  // Key hints wrap on a narrow terminal instead of losing their last keys.
  const noticeRows = notice ? wrapCells(notice, width) : [];
  const baseHints = [...noticeRows, ...wrapCells(hintText, width)];
  const minimum = reserve === undefined ? MIN_BODY_ROWS : 1;
  const bodyRoom = terminalRows - reserved - FRAME_ROWS - footerRows - (noteText === null ? 0 : 1) - (waitingText === null ? 0 : 1);
  const hintRows = scrollHint && hintText === keyHints && rows.length > Math.max(minimum, bodyRoom - baseHints.length + 1)
    ? [...noticeRows, ...wrapCells(`${scrollHint} · ${hintText}`, width)] : baseHints;
  const room = Math.max(minimum, bodyRoom - hintRows.length + 1);
  const overflow = rows.length > room, visible = overflow ? Math.max(1, room - 1) : rows.length;
  const [offset, setOffset] = useState(0);
  const revealRow = reveal === undefined ? undefined : starts[reveal];
  // Keep the revealed line in view: scroll only as far as needed, so the person's own paging stays where it was otherwise.
  useEffect(() => {
    if (revealRow === undefined) return;
    setOffset(value => revealRow < value ? revealRow : revealRow >= value + visible ? revealRow - visible + 1 : value);
  }, [revealRow, visible]);
  const latest = useRef({ total: rows.length, visible, onInput, onClose, onPaste, inputRevision, burstText, title, body, copy, copyOptions });
  latest.current = { total: rows.length, visible, onInput, onClose, onPaste, inputRevision, burstText, title, body, copy, copyOptions };
  const copyCard = () => {
    typing.settle();
    const { copy: writer, title: shownTitle, body: shownBody } = latest.current;
    if (!writer) return;
    const text = humanRecordText(cardCopyText(shownTitle, shownBody, [...latest.current.copyOptions, ...[...optionLabels.current.values()].flat()]), known), result = writer.write(text);
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
    if (guarded && !current.burstText) {
      if (typing.early.current !== null && printable(input, key)) {
        if (input !== typing.early.current) { typing.set(true); return; }
        typing.set(false);
      }
      if (typing.typed.current && printable(input, key)) return;
      if ((typing.typed.current || typing.early.current !== null) && key.return && !key.ctrl && !key.meta && !key.shift) { typing.set(false, true); return; }
      if (navigationKey(key) || !key.ctrl && !key.meta && !key.shift && (key.leftArrow || key.rightArrow)) typing.set(false);
    }
    if (current.onInput?.(input, key) === true) { typing.settle(); return; }
    if (guarded && !current.burstText && printable(input, key)) typing.set(true);
    const scroll = scrollKeyOf(key);
    if (scroll) { setOffset(value => scrollBy(value, scroll, current.total, current.visible)); return; }
    if (key.escape && current.onClose) current.onClose();
  };
  // Security review 2026-10-18 (keystroke race): Ink parses one stdin read into several key events and dispatches them synchronously, so a
  // decision window gathers the events of one read and looks at them after the read: a single event is a key press; several (an escape
  // sequence plus a letter, "text⌫y", a coalesced burst) never decide. Focus or card changes during the read drop it. Fail closed.
  const burst = useRef<{ events: Array<readonly [string, Key]>; owned: boolean; revision: number | undefined } | null>(null);
  const flush = () => {
    const read = burst.current; burst.current = null;
    if (!read) return;
    // Owner 109: only the one unambiguous printable key of a whole unarmed period is remembered; any other swallowed text is typed text.
    const ignoredText = (unarmed = false) => {
      if (!read.owned || !acceptsInput() || latest.current.burstText || !read.events.some(([input, key]) => printable(input, key))) return;
      const lone = unarmed && !typing.typed.current && typing.early.current === null ? loneKey(read.events) : null;
      if (lone === null) typing.set(true); else typing.remember(lone);
    };
    // A read of copy keys only copies and leaves the arming as it was; mixed with other keys it is one more event of a burst (never decides).
    if (read.events.every(([input, key]) => copyKey(input, key))) { if (read.owned && acceptsInput()) copyCard(); return; }
    if (read.revision !== latest.current.inputRevision) { ignoredText(); arming.restart(); return; }
    if (!read.owned || !acceptsInput() || !arming.armed()) { ignoredText(true); arming.touch(); return; }
    if (read.events.length === 1) { const [input, key] = read.events[0]!; deliver(input, key); return; }
    // A read of navigation keys only (held PgDn, a coalesced run of arrows) moves the view or the highlight and never decides: delivered.
    if (read.events.every(([, key]) => navigationKey(key))) { for (const [input, key] of read.events) deliver(input, key); return; }
    // Several events in one read: only an owner taking plain text right now gets them (as text), and the first one it does not take ends
    // the read and re-arms; any other owner never sees such a read (security review 2026-10-18, fail-open burst handling).
    if (!latest.current.burstText) { ignoredText(); arming.restart(); return; }
    for (const [input, key] of read.events) if (latest.current.onInput?.(input, key, { burst: true }) !== true) { ignoredText(); arming.restart(); return; }
  };
  const begin = () => { if (!burst.current) { burst.current = { events: [], owned: true, revision: latest.current.inputRevision }; setImmediate(flush); } return burst.current; };
  useInput((input, key) => {
    if (queuedList && !acceptsListInput()) return;
    // S5: adding a line never answers any window's choice or confirmation. Shift+Enter is a new line too (Astra 3134: an owner that takes
    // every Return would otherwise answer on it after typed text, which only a plain Enter ends).
    if (key.return && (key.ctrl || key.meta || key.shift)) { if (guarded) begin().owned = false; return; }
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
    if (queuedList && !acceptsListInput()) return;
    if (!acceptsInput()) return;
    // An entry window takes a paste only while it holds the keyboard (owner F2-18, Astra 3052 R1); a decision card never decides on one.
    if (!guarded) { latest.current.onPaste?.(text); return; }
    if (!arming.armed()) { if (text.length && !latest.current.burstText) typing.set(true); arming.touch(); return; }
    if (!latest.current.onPaste && text.length) typing.set(true);
    if (latest.current.onPaste) latest.current.onPaste(text); else arming.restart();
  }, { isActive: focused && (guarded || onPaste !== undefined) });
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
      {rows.slice(first, first + visible).map((row, index) => {
        const at = first + index, logicalLine = rowLines[at]!.line;
        const ends = hyperlinkEnds(links[at]), range = picked ? cardRowRange(picked, at) : null;
        const text = <Text key={at} wrap="truncate">{ends?.open}{range ? highlightCells(plainText(row) || ' ', range.start, range.end, palette.selection)
          : row.length ? <SpanText spans={row} /> : ' '}{ends?.close}</Text>;
        const onDrawn = body[logicalLine]?.onDrawn;
        if (!onDrawn) return text;
        const precedingText = rows.slice(starts[logicalLine], at).map(plainText).join('');
        return <DrawnText key={at} text={plainText(row)} precedingText={precedingText} onDrawn={onDrawn}>{text}</DrawnText>;
      })}
      {overflow ? <Text {...palette.muted} wrap="truncate">{fillTemplate(position, { from: first + 1, to: Math.min(rows.length, first + visible), total: rows.length })}</Text> : null}
      {footer ? <WindowInputContext.Provider value={queuedList ? acceptsListInput : acceptsInput}><CardCopyOptionsContext.Provider value={optionLabels.current}>{footer(focused, width)}</CardCopyOptionsContext.Provider></WindowInputContext.Provider> : null}
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
