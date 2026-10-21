import { cells, graphemes } from '#surfaces/core/terminal-render/index.js';
import type { ViewportBlocks } from './viewport.js';

/**
 * In-app text selection of the full-window conversation (TERM-POLISH, owner 2026-10-20; the Claude Code fullscreen renderer's click-and-drag
 * selection, code.claude.com/docs/en/fullscreen read 2026-10-20). A point is anchored to the content (block key, line in it, display cell),
 * not to a screen row, so streaming or scrolling never moves what the person selected. The copied text is the displayed text: the same
 * secret-projected lines the view draws, without colour codes or the trailing padding of each line.
 */
export type SelectionPoint = Readonly<{ key: string; line: number; cell: number }>;

// eslint-disable-next-line no-control-regex -- display lines carry SGR colour codes.
const SGR_TOKEN = /\u001b\[[\d;]*m/u;
// eslint-disable-next-line no-control-regex -- display lines carry SGR colour codes.
const SGR_ALL = /\u001b\[[\d;]*m/gu;
const REVERSE_ON = '\u001b[7m', REVERSE_OFF = '\u001b[27m';

export const stripSgr = (text: string): string => text.replace(SGR_ALL, '');

/** −1, 0 or 1: document order of two points (an unknown key sorts first; the caller drops such a selection). */
export function comparePoints(blocks: ViewportBlocks, a: SelectionPoint, b: SelectionPoint): number {
  const left = blocks.keys.indexOf(a.key), right = blocks.keys.indexOf(b.key);
  return Math.sign(left - right || a.line - b.line || a.cell - b.cell);
}

/** The cells `start`..`end` (inclusive, 0-based) of a plain line; a wide character half inside the range is taken whole. */
function sliceCells(plain: string, start: number, end: number): string {
  let at = 0, out = '';
  for (const cluster of graphemes(plain)) {
    const width = cells(cluster), last = at + Math.max(1, width) - 1;
    if (last >= start && at <= end) out += cluster;
    at += width;
    if (at > end) break;
  }
  return out;
}

/** The selected text from `a` to `b` (either order, both inclusive): whole lines between them, joined by newlines. */
export function selectedText(blocks: ViewportBlocks, a: SelectionPoint, b: SelectionPoint): string {
  const [from, to] = comparePoints(blocks, a, b) <= 0 ? [a, b] : [b, a];
  const first = blocks.keys.indexOf(from.key), last = blocks.keys.indexOf(to.key);
  if (first < 0 || last < 0) return '';
  const out: string[] = [];
  for (let index = first; index <= last; index++) {
    const lines = blocks.linesOf(index);
    const begin = index === first ? from.line : 0, finish = index === last ? Math.min(to.line, lines.length - 1) : lines.length - 1;
    for (let line = begin; line <= finish; line++) {
      const plain = stripSgr(lines[line] ?? '');
      const start = index === first && line === from.line ? from.cell : 0, end = index === last && line === to.line ? to.cell : Number.MAX_SAFE_INTEGER;
      out.push(sliceCells(plain, start, end).trimEnd());
    }
  }
  return out.join('\n');
}

/** The cell range of one display line that a selection covers (inclusive), or null when the line is outside it. */
export function lineRange(blocks: ViewportBlocks, a: SelectionPoint, b: SelectionPoint, key: string, line: number): Readonly<{ start: number; end: number }> | null {
  const [from, to] = comparePoints(blocks, a, b) <= 0 ? [a, b] : [b, a];
  const here = { key, line, cell: 0 };
  if (comparePoints(blocks, { ...here, cell: Number.MAX_SAFE_INTEGER }, from) < 0 || comparePoints(blocks, here, to) > 0) return null;
  return { start: from.key === key && from.line === line ? from.cell : 0, end: to.key === key && to.line === line ? to.cell : Number.MAX_SAFE_INTEGER };
}

/** The line with cells `start`..`end` in reverse video; the line's own colour codes are kept and the reverse is restored after each one. */
export function highlightCells(line: string, start: number, end: number): string {
  let rest = line, at = 0, out = '', inside = false;
  while (rest.length > 0) {
    const code = SGR_TOKEN.exec(rest);
    const textEnd = code ? code.index : rest.length;
    for (const cluster of graphemes(rest.slice(0, textEnd))) {
      const width = cells(cluster), last = at + Math.max(1, width) - 1, covered = last >= start && at <= end;
      if (covered && !inside) { out += REVERSE_ON; inside = true; } else if (!covered && inside) { out += REVERSE_OFF; inside = false; }
      out += cluster; at += width;
    }
    if (!code) break;
    out += code[0] + (inside ? REVERSE_ON : '');
    rest = rest.slice(textEnd + code[0].length);
  }
  return inside ? out + REVERSE_OFF : out;
}
