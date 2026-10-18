/**
 * Pure scroll model of the full-window chat viewport (TERMINAL-SABIT-DUZEN, the Claude Code fullscreen renderer's behaviour): the
 * conversation is a list of blocks whose display lines are produced lazily (`linesOf`, cached by the caller), so only the blocks around
 * the view are ever laid out. `null` anchor = follow the newest line; an anchor pins the first visible line to a block key and a line in
 * it, so lines appended below (streaming) or blocks laid out above (scrolling back) never move what the person is reading.
 */
export type ViewportAnchor = Readonly<{ key: string; line: number }> | null;
export type ViewportBlocks = Readonly<{ keys: readonly string[]; linesOf: (index: number) => readonly string[] }>;
type Position = Readonly<{ index: number; line: number }>;

function positionOf(blocks: ViewportBlocks, anchor: Exclude<ViewportAnchor, null>): Position | null {
  const index = blocks.keys.indexOf(anchor.key);
  // A block that left the bounded history (or a cleared conversation): the oldest line still there.
  if (index < 0) return blocks.keys.length ? { index: 0, line: 0 } : null;
  return { index, line: Math.min(anchor.line, Math.max(0, blocks.linesOf(index).length - 1)) };
}

/** Lines from `from` to the end, counting at most `limit` (the caller only needs to know whether the end is within reach). */
function linesToEnd(blocks: ViewportBlocks, from: Position, limit: number): number {
  let count = blocks.linesOf(from.index).length - from.line;
  for (let index = from.index + 1; index < blocks.keys.length && count <= limit; index++) count += blocks.linesOf(index).length;
  return count;
}

function back(blocks: ViewportBlocks, from: Position, count: number): Position {
  let { index, line } = from, left = count;
  while (left > 0) {
    if (line >= left) return { index, line: line - left };
    left -= line;
    if (index === 0) return { index: 0, line: 0 };
    index -= 1; line = blocks.linesOf(index).length;
  }
  return { index, line };
}

function forward(blocks: ViewportBlocks, from: Position, count: number): Position {
  let { index, line } = from, left = count;
  while (left > 0) {
    const size = blocks.linesOf(index).length;
    if (line + left < size) return { index, line: line + left };
    left -= size - line;
    if (index === blocks.keys.length - 1) return { index, line: Math.max(0, size - 1) };
    index += 1; line = 0;
  }
  return { index, line };
}

/** The first visible line while following: `height` lines above the end (or the very first line of a short conversation). */
function followTop(blocks: ViewportBlocks, height: number): Position | null {
  const last = blocks.keys.length - 1;
  return last < 0 ? null : back(blocks, { index: last, line: blocks.linesOf(last).length }, height);
}

const anchorOf = (blocks: ViewportBlocks, position: Position): ViewportAnchor => ({ key: blocks.keys[position.index]!, line: position.line });

/** `delta` lines (negative = back). Reaching the last screenful returns to follow, as Claude Code resumes auto-follow at the bottom. */
export function scrollViewport(blocks: ViewportBlocks, anchor: ViewportAnchor, height: number, delta: number): ViewportAnchor {
  const view = Math.max(1, height);
  const from = anchor ? positionOf(blocks, anchor) : followTop(blocks, view);
  if (!from) return null;
  const next = delta < 0 ? back(blocks, from, -delta) : forward(blocks, from, delta);
  return linesToEnd(blocks, next, view) <= view ? null : anchorOf(blocks, next);
}

/** Ctrl+Home: the first line of the conversation (follow when it all fits). */
export function viewportStart(blocks: ViewportBlocks, height: number): ViewportAnchor {
  if (!blocks.keys.length) return null;
  const first = { index: 0, line: 0 };
  return linesToEnd(blocks, first, Math.max(1, height)) <= Math.max(1, height) ? null : anchorOf(blocks, first);
}

/**
 * The lines to draw. Following: the last `height` lines (the live answer follows them and the frame clips the top). Anchored: `height - 1`
 * lines from the anchor and `below`, the count of lines under the view, for the one indicator row that replaces the last line.
 */
export function viewportLines(blocks: ViewportBlocks, anchor: ViewportAnchor, height: number): Readonly<{ lines: readonly string[]; below: number | null }> {
  const view = Math.max(1, height);
  const from = anchor ? positionOf(blocks, anchor) : followTop(blocks, view);
  if (!from) return { lines: [], below: null };
  const room = anchor ? Math.max(1, view - 1) : view, lines: string[] = [];
  let { index, line } = from;
  while (index < blocks.keys.length && lines.length < room) {
    const block = blocks.linesOf(index);
    lines.push(...block.slice(line, line + room - lines.length));
    index += 1; line = 0;
  }
  return { lines, below: anchor ? Math.max(0, linesToEnd(blocks, from, Number.MAX_SAFE_INTEGER) - room) : null };
}

/**
 * Transcript search and prompt jumps (harness gap 4, the Claude Code focused-transcript pattern): only the lines this view keeps (bounded
 * history, already projected for display) are searched. `layout` lays a block out outside any render; `isPrompt` marks the person's own
 * messages. Both are optional: without them search and jumps find nothing.
 */
export type SearchableBlocks = ViewportBlocks & Readonly<{ layout?: (index: number) => readonly string[]; isPrompt?: (index: number) => boolean }>;

// eslint-disable-next-line no-control-regex -- display lines carry SGR colour codes.
const SGR = /\u001b\[[\d;]*m/gu;

function topOf(blocks: ViewportBlocks, anchor: ViewportAnchor, height: number): Position | null {
  return anchor ? positionOf(blocks, anchor) : followTop(blocks, Math.max(1, height));
}

/** The next line containing `query` (case-insensitive) older (−1) or newer (+1) than the view's first line; the found line is put on top. */
export function searchViewport(blocks: SearchableBlocks, anchor: ViewportAnchor, height: number, query: string, direction: -1 | 1): ViewportAnchor | 'none' {
  const needle = query.toLocaleLowerCase(), from = topOf(blocks, anchor, height);
  if (!needle || !from) return 'none';
  const lines = (index: number) => (blocks.layout ?? blocks.linesOf)(index);
  const hit = (index: number, line: number) => (lines(index)[line] ?? '').replace(SGR, '').toLocaleLowerCase().includes(needle);
  let index = from.index, line = from.line;
  for (;;) {
    line += direction;
    while (line < 0 || line >= lines(index).length) {
      index += direction;
      if (index < 0 || index >= blocks.keys.length) return 'none';
      line = direction < 0 ? lines(index).length - 1 : 0;
    }
    if (hit(index, line)) return { key: blocks.keys[index]!, line };
  }
}

/** The previous (−1) or next (+1) message of the person relative to the view's first line; past the newest one the view follows again. */
export function promptJump(blocks: SearchableBlocks, anchor: ViewportAnchor, height: number, direction: -1 | 1): ViewportAnchor {
  const from = topOf(blocks, anchor, height), isPrompt = blocks.isPrompt, view = Math.max(1, height);
  if (!from || !isPrompt) return anchor;
  const at = (index: number): ViewportAnchor => linesToEnd(blocks, { index, line: 0 }, view) <= view ? null : { key: blocks.keys[index]!, line: 0 };
  if (direction < 0) {
    for (let index = from.line > 0 ? from.index : from.index - 1; index >= 0; index--) if (isPrompt(index)) return at(index);
    return anchor;
  }
  for (let index = from.index + 1; index < blocks.keys.length; index++) if (isPrompt(index)) return at(index);
  return null;
}
