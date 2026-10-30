import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useBoxMetrics, useInput, useWindowSize, type DOMElement } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate } from '#surfaces/core/terminal-render/index.js';
import { WindowStackProvider, WINDOW_PRIORITY, useFocusOwner } from './window-stack.js';
import { MainScreenContext } from './card-copy.js';
import { promptJump, scrollViewport, searchViewport, viewportLines, viewportStart, type SearchableBlocks, type ViewportAnchor } from './viewport.js';
import type { PointerEvent, PointerSource, WheelSource } from './mouse.js';
import { highlightCells, lineRange, selectedText, type SelectionPoint } from './selection.js';

/**
 * Full-window Workline (TERMINAL-SABIT-DUZEN, owner 2026-10-18; the Claude Code fullscreen renderer's model): the view owns the alternate
 * screen and is exactly one frame tall. Top to bottom: the chat viewport (only the conversation; it takes what is left and keeps its newest
 * line at the bottom), windows and cards (capped at half the frame, they shrink the viewport, never move the bar), the input bar, and a
 * fixed-height information region (state, mode, work, hints). The bar's bottom row therefore depends only on the terminal size and the
 * information height: a growing chat, a streamed answer or a window opening and closing never moves it.
 */
export function fullscreenFrameRows(rows: number, platform: NodeJS.Platform = process.platform): number {
  // Ink fully clears a frame that fills a Windows console on every render (ink.js isWindowsConsole); one spare row keeps it incremental.
  return Math.max(1, platform === 'win32' ? rows - 1 : rows);
}

/** Information rows under the bar: state, activity (work / mode / notices), key hints; fewer on a short terminal, never more than three. */
export function fullscreenInfoRows(rows: number): number {
  return rows >= 12 ? 3 : rows >= 8 ? 2 : 1;
}

export function FullscreenWorkline({ viewport, above, bar, info }: { readonly viewport: ReactNode; readonly above: ReactNode; readonly bar: ReactNode; readonly info: ReactNode }) {
  const size = useWindowSize(), rows = fullscreenFrameRows(size.rows || 24), columns = size.columns || 80;
  // A card or window takes at most half the frame (it scrolls inside); `reservedRows` is what Window subtracts from the terminal rows.
  const cap = Math.max(3, Math.floor(rows / 2));
  return <WindowStackProvider composerDefault reservedRows={Math.max(0, (size.rows || 24) - cap)}><MainScreenContext.Provider value={false}>
    <Box flexDirection="column" height={rows} width={columns} overflow="hidden">
      {viewport}
      <Box flexDirection="column" flexShrink={0} maxHeight={cap} overflow="hidden" justifyContent="flex-end">{above}</Box>
      <BarSlot>{bar}</BarSlot>
      <Box flexDirection="column" flexShrink={0} height={fullscreenInfoRows(rows)} overflow="hidden">{info}</Box>
    </Box>
  </MainScreenContext.Provider></WindowStackProvider>;
}

/** A decision that holds the keyboard takes the bar's place (Claude Code style): the composer stays mounted, so its draft returns with it. */
function BarSlot({ children }: { readonly children: ReactNode }) {
  const owner = useFocusOwner(), deciding = owner.topPriority !== null && owner.topPriority >= WINDOW_PRIORITY.approval && !owner.composing;
  return <Box flexDirection="column" flexShrink={0} display={deciding ? 'none' : 'flex'}>{children}</Box>;
}

/** `below`: lines under the view while scrolled back; `newMessages`: conversation entries that arrived since (`{count}`). */
export type ChatViewportLabels = Readonly<{ below: string; newMessages?: string;
  /** Transcript search row (harness gap 4): `{query}`, `{state}` (empty, or `searchNone`). Absent: no search. */
  search?: string; searchNone?: string;
  /** TERM-POLISH: the hint row after a mouse selection was copied (`{count}` characters); names the terminal's own selection key. */
  copied?: string }>;
/** The full window's mouse wheel (mouse.ts); absent where the mouse is not captured. */
export const WheelContext = createContext<WheelSource | null>(null);
/** The full window's left-button pointer (mouse.ts) and the host's clipboard write for the selected text; absent where the mouse is not captured. */
export type PointerSelection = Readonly<{ pointer: PointerSource; copy: (text: string) => void }>;
export const PointerContext = createContext<PointerSelection | null>(null);
type Selection = Readonly<{ anchor: SelectionPoint; focus: SelectionPoint; dragging: boolean }>;
/** How long the "copied" line stays in the hint row after a selection is copied. */
const COPIED_NOTICE_MS = 4_000;
const NEUTRAL_COPIED = '{count} copied (OSC 52) · Shift+drag';

/** The host's pointer and clipboard write as the viewport's selection context, and the copied character count for the hint row (it clears
 * itself after a moment; characters are counted as the person sees them). Without a pointer or a clipboard write there is no selection. */
export function usePointerCopy(pointer: PointerSource | undefined, copyText: ((text: string) => void) | undefined): Readonly<{ selection: PointerSelection | null; copied: number | null }> {
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => { if (copied === null) return undefined; const timer = setTimeout(() => setCopied(null), COPIED_NOTICE_MS); return () => clearTimeout(timer); }, [copied]);
  const selection = useMemo(() => pointer && copyText ? { pointer, copy: (text: string) => { copyText(text); setCopied([...text].length); } } : null, [pointer, copyText]);
  return { selection, copied };
}

/** The hint row's "copied" line (`terminal.viewport.copied`; it names the terminal's own selection key for a terminal that blocks OSC 52). */
export function CopiedNotice({ count, label }: { readonly count: number; readonly label: string | undefined }) {
  const palette = useWorklinePalette();
  return <Text {...palette.accent} wrap="truncate-end">{fillTemplate(label ?? NEUTRAL_COPIED, { count })}</Text>;
}
/** Lines one wheel notch scrolls (the vim / Claude Code default of three). */
const WHEEL_LINES = 3;

/**
 * The scrolling conversation. Follows the newest line (and the live answer after it) until the person scrolls back: PgUp/PgDn move half a
 * view, Ctrl+Home goes to the first line, Ctrl+End returns to the newest line and follows again (the Claude Code fullscreen keys). While
 * scrolled back the view stays put as lines arrive and the last row says how many lines are below. `active`: the composer owns the keyboard
 * (a focused window keeps its own PgUp/PgDn).
 */
export function ChatViewport({ blocks, live, active, labels, onSearch }: { readonly blocks: SearchableBlocks; readonly live?: ReactNode; readonly active: boolean;
  readonly labels: ChatViewportLabels; readonly onSearch?: (open: boolean) => void }) {
  const palette = useWorklinePalette(), size = useWindowSize();
  const ref = useRef<DOMElement | null>(null), metrics = useBoxMetrics(ref), innerRef = useRef<DOMElement | null>(null), inner = useBoxMetrics(innerRef);
  const height = Math.max(1, metrics.height || Math.floor((size.rows || 24) / 2));
  const [anchor, setAnchorState] = useState<ViewportAnchor>(null);
  // Entries present when the person scrolled back: what arrived since is "new" for the jump-to-latest row (Claude Code: "N new messages").
  const seen = useRef(0), anchored = useRef(false);
  const setAnchor = (next: ViewportAnchor | ((value: ViewportAnchor) => ViewportAnchor)) => setAnchorState(value => {
    const resolved = typeof next === 'function' ? next(value) : next;
    if (resolved !== null && !anchored.current) seen.current = latest.current.blocks.keys.length;
    anchored.current = resolved !== null;
    return resolved;
  });
  const latest = useRef({ blocks, height }); latest.current = { blocks, height };
  const anchorRef = useRef(anchor); anchorRef.current = anchor;
  const owner = useFocusOwner(), wheel = useContext(WheelContext), pointer = useContext(PointerContext);
  // TERM-POLISH: click and drag selects the conversation's text (content-anchored), the release copies it; a plain click or any key but
  // the scroll keys clears it (the Claude Code fullscreen behaviour).
  const [selection, setSelectionState] = useState<Selection | null>(null), selectionRef = useRef(selection);
  const setSelection = (next: Selection | null) => { selectionRef.current = next; setSelectionState(next); };
  const drawn = useRef<DrawnLines>({ top: 0, at: [], lines: [] });
  // Search over this view's kept lines (Ctrl+F while scrolled back); while it is open it takes the typed keys from the composer.
  const [search, setSearch] = useState<Readonly<{ query: string; none: boolean }> | null>(null), searchRef = useRef(search); searchRef.current = search;
  const openSearch = (next: Readonly<{ query: string; none: boolean }> | null) => { searchRef.current = next; setSearch(next); onSearch?.(next !== null); };
  const find = (query: string, direction: -1 | 1) => setImmediate(() => {
    const { blocks: current, height: view } = latest.current, found = searchViewport(current, anchorRef.current, view, query, direction);
    if (found === 'none') { if (searchRef.current) openSearch({ query, none: true }); return; }
    setAnchor(found); if (searchRef.current) openSearch({ query, none: false });
  });
  // A cleared or emptied conversation follows again.
  useEffect(() => { if (blocks.keys.length === 0) setAnchor(null); }, [blocks.keys.length]);
  // The wheel scrolls the conversation whoever holds the keyboard; it is never a key, so it can neither type nor answer a card.
  useEffect(() => wheel?.subscribe(step => setAnchor(value => scrollViewport(latest.current.blocks, value, latest.current.height, step * WHEEL_LINES))), [wheel]);
  useEffect(() => pointer?.pointer.subscribe(event => {
    const view = drawn.current, current = selectionRef.current;
    const point = pointAt(view, event);
    if (event.kind === 'press') { setSelection(point && !point.clamped ? { anchor: point.at, focus: point.at, dragging: true } : null); return; }
    if (!current?.dragging) return;
    if (event.kind === 'drag') { if (point) setSelection({ ...current, focus: point.at }); return; }
    const done = { ...current, focus: point?.at ?? current.focus, dragging: false };
    if (done.focus.key === done.anchor.key && done.focus.line === done.anchor.line && done.focus.cell === done.anchor.cell) { setSelection(null); return; }
    setSelection(done);
    const text = selectedText(latest.current.blocks, done.anchor, done.focus);
    if (text.trim()) pointer.copy(text);
  }), [pointer]);
  // Any key but the scroll keys clears a selection (it never takes the key: the composer or the window still gets it).
  useInput((_input, key) => {
    if (!key.pageUp && !key.pageDown && !(key.ctrl && (key.home || key.end)) && !key.shift) setSelection(null);
  }, { isActive: selection !== null && !selection.dragging });
  useInput((input, key) => {
    const { blocks: current, height: view } = latest.current, half = Math.max(1, Math.floor(view / 2)), open = searchRef.current;
    if (open) {
      if (key.escape) openSearch(null);
      else if (key.return || key.upArrow) find(open.query, -1);
      else if (key.downArrow) find(open.query, 1);
      else if (key.backspace || key.delete) openSearch({ query: [...open.query].slice(0, -1).join(''), none: false });
      else if (!key.ctrl && !key.meta && input && [...input].every(char => char.charCodeAt(0) >= 32)) { const query = open.query + input; openSearch({ query, none: false }); find(query, -1); }
      return;
    }
    if (key.ctrl && input === 'f' && anchored.current && labels.search) { openSearch({ query: '', none: false }); return; }
    if (key.ctrl && key.upArrow) { setAnchor(value => promptJump(current, value, view, -1)); return; }
    if (key.ctrl && key.downArrow) { setAnchor(value => promptJump(current, value, view, 1)); return; }
    if (key.pageUp) setAnchor(value => scrollViewport(current, value, view, -half));
    else if (key.pageDown) setAnchor(value => scrollViewport(current, value, view, half));
    else if (key.ctrl && key.home) setAnchor(viewportStart(current, view));
    else if (key.ctrl && key.end) setAnchor(null);
    // While scrolled back, plain Home/End jump too (the composer's line keys work again once the view follows).
    else if (anchored.current && key.end) setAnchor(null);
    else if (anchored.current && key.home) setAnchor(viewportStart(current, view));
  }, { isActive: active && owner.composing });
  const { lines, at, below } = viewportLines(blocks, anchor, height), fresh = anchor ? Math.max(0, blocks.keys.length - seen.current) : 0;
  // Where the drawn lines are: the inner column is bottom-aligned (and clipped at the top while following), so its measured top is the offset.
  drawn.current = { top: metrics.top + inner.top, at, lines };
  const shown = selection && blocks.keys.includes(selection.anchor.key) && blocks.keys.includes(selection.focus.key) ? selection : null;
  return <Box ref={ref} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden" justifyContent="flex-end">
    <Box ref={innerRef} flexDirection="column" flexShrink={0}>
      {lines.map((line, index) => {
        const range = shown ? lineRange(blocks, shown.anchor, shown.focus, at[index]!.key, at[index]!.line) : null, text = line === '' ? ' ' : line;
        return <Text key={index} wrap="truncate">{range ? highlightCells(text, range.start, range.end) : text}</Text>;
      })}
      {search && labels.search ? <Text {...palette.accent} wrap="truncate-end">{fillTemplate(labels.search, { query: search.query, state: search.none ? labels.searchNone ?? '' : '' })}</Text>
        : below === null ? live : <Text {...palette.accent} wrap="truncate-end">{fresh > 0 && labels.newMessages
        ? fillTemplate(labels.newMessages, { count: fresh }) : fillTemplate(labels.below, { count: below })}</Text>}
    </Box>
  </Box>;
}

type DrawnLines = Readonly<{ top: number; at: readonly Readonly<{ key: string; line: number }>[]; lines: readonly string[] }>;

/** The content point under a pointer event; a row above or below the drawn lines is clamped to the first or last one (`clamped`). */
function pointAt(view: DrawnLines, event: PointerEvent): Readonly<{ at: SelectionPoint; clamped: boolean }> | null {
  if (view.at.length === 0) return null;
  const row = event.row - view.top, index = Math.min(view.at.length - 1, Math.max(0, row)), place = view.at[index]!;
  const clamped = row !== index;
  const cell = row < 0 ? 0 : row >= view.at.length ? Number.MAX_SAFE_INTEGER : event.column;
  return { at: { key: place.key, line: place.line, cell }, clamped };
}
