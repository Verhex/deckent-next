import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useBoxMetrics, useInput, useWindowSize, type DOMElement } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate } from '#surfaces/core/terminal-render/index.js';
import { WindowStackProvider, WINDOW_PRIORITY, useFocusOwner } from './window-stack.js';
import { scrollViewport, viewportLines, viewportStart, type ViewportAnchor, type ViewportBlocks } from './viewport.js';
import type { WheelSource } from './mouse.js';

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
  return <WindowStackProvider composerDefault reservedRows={Math.max(0, (size.rows || 24) - cap)}>
    <Box flexDirection="column" height={rows} width={columns} overflow="hidden">
      {viewport}
      <Box flexDirection="column" flexShrink={0} maxHeight={cap} overflow="hidden" justifyContent="flex-end">{above}</Box>
      <BarSlot>{bar}</BarSlot>
      <Box flexDirection="column" flexShrink={0} height={fullscreenInfoRows(rows)} overflow="hidden">{info}</Box>
    </Box>
  </WindowStackProvider>;
}

/** A decision that holds the keyboard takes the bar's place (Claude Code style): the composer stays mounted, so its draft returns with it. */
function BarSlot({ children }: { readonly children: ReactNode }) {
  const owner = useFocusOwner(), deciding = owner.topPriority !== null && owner.topPriority >= WINDOW_PRIORITY.approval && !owner.composing;
  return <Box flexDirection="column" flexShrink={0} display={deciding ? 'none' : 'flex'}>{children}</Box>;
}

/** `below`: lines under the view while scrolled back; `newMessages`: conversation entries that arrived since (`{count}`). */
export type ChatViewportLabels = Readonly<{ below: string; newMessages?: string }>;
/** The full window's mouse wheel (mouse.ts); absent where the mouse is not captured. */
export const WheelContext = createContext<WheelSource | null>(null);
/** Lines one wheel notch scrolls (the vim / Claude Code default of three). */
const WHEEL_LINES = 3;

/**
 * The scrolling conversation. Follows the newest line (and the live answer after it) until the person scrolls back: PgUp/PgDn move half a
 * view, Ctrl+Home goes to the first line, Ctrl+End returns to the newest line and follows again (the Claude Code fullscreen keys). While
 * scrolled back the view stays put as lines arrive and the last row says how many lines are below. `active`: the composer owns the keyboard
 * (a focused window keeps its own PgUp/PgDn).
 */
export function ChatViewport({ blocks, live, active, labels }: { readonly blocks: ViewportBlocks; readonly live?: ReactNode; readonly active: boolean;
  readonly labels: ChatViewportLabels }) {
  const palette = useWorklinePalette(), size = useWindowSize();
  const ref = useRef<DOMElement | null>(null), metrics = useBoxMetrics(ref);
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
  const owner = useFocusOwner(), wheel = useContext(WheelContext);
  // A cleared or emptied conversation follows again.
  useEffect(() => { if (blocks.keys.length === 0) setAnchor(null); }, [blocks.keys.length]);
  // The wheel scrolls the conversation whoever holds the keyboard; it is never a key, so it can neither type nor answer a card.
  useEffect(() => wheel?.subscribe(step => setAnchor(value => scrollViewport(latest.current.blocks, value, latest.current.height, step * WHEEL_LINES))), [wheel]);
  useInput((_input, key) => {
    const { blocks: current, height: view } = latest.current, half = Math.max(1, Math.floor(view / 2));
    if (key.pageUp) setAnchor(value => scrollViewport(current, value, view, -half));
    else if (key.pageDown) setAnchor(value => scrollViewport(current, value, view, half));
    else if (key.ctrl && key.home) setAnchor(viewportStart(current, view));
    else if (key.ctrl && key.end) setAnchor(null);
    // While scrolled back, plain Home/End jump too (the composer's line keys work again once the view follows).
    else if (anchored.current && key.end) setAnchor(null);
    else if (anchored.current && key.home) setAnchor(viewportStart(current, view));
  }, { isActive: active && owner.composing });
  const { lines, below } = viewportLines(blocks, anchor, height), fresh = anchor ? Math.max(0, blocks.keys.length - seen.current) : 0;
  return <Box ref={ref} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden" justifyContent="flex-end">
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((line, index) => <Text key={index} wrap="truncate">{line === '' ? ' ' : line}</Text>)}
      {below === null ? live : <Text {...palette.accent} wrap="truncate-end">{fresh > 0 && labels.newMessages
        ? fillTemplate(labels.newMessages, { count: fresh }) : fillTemplate(labels.below, { count: below })}</Text>}
    </Box>
  </Box>;
}
