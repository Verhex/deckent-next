/**
 * Draft text geometry: grapheme clusters, terminal cell widths and wrapped rows. Pure; no Ink, no I/O.
 * Offsets are UTF-16 indexes that always sit on a grapheme-cluster boundary, so an emoji, a flag, a ZWJ family or
 * a letter with combining marks moves and deletes as one unit (legacy cursor-model TERMINAL-TOOLS-005).
 */
const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });

export function graphemes(text: string): string[] {
  return Array.from(GRAPHEMES.segment(text), part => part.segment);
}

type Range = readonly [number, number];
// Approximate East-Asian-Wide + emoji table: enough for caret and wrap math, not a Unicode conformance claim.
const WIDE: readonly Range[] = [[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f1e6, 0x1f1ff], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd]];
const ZERO: readonly Range[] = [[0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f],
  [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0e], [0xfe20, 0xfe2f], [0xe0100, 0xe01ef]];
const within = (point: number, ranges: readonly Range[]) => ranges.some(([low, high]) => point >= low && point <= high);

/** Cells one cluster occupies: 2 for wide or emoji-presentation (VS16), 0 for marks only, otherwise 1. */
export function clusterWidth(cluster: string): 0 | 1 | 2 {
  let narrow = false;
  for (const char of cluster) {
    const point = char.codePointAt(0)!;
    if (point === 0xfe0f || within(point, WIDE)) return 2;
    if (!within(point, ZERO)) narrow = true;
  }
  return narrow ? 1 : 0;
}

export function displayWidth(text: string): number {
  return graphemes(text).reduce((sum, cluster) => sum + clusterWidth(cluster), 0);
}

/** Largest cluster boundary at or before `offset` (an offset inside a cluster snaps to its start). */
export function snapToCluster(text: string, offset: number): number {
  let at = 0;
  for (const cluster of graphemes(text)) {
    if (at + cluster.length > offset) return at;
    at += cluster.length;
  }
  return at;
}

export function previousBoundary(text: string, offset: number): number {
  const before = graphemes(text.slice(0, offset));
  return offset - (before.at(-1)?.length ?? 0);
}

export function nextBoundary(text: string, offset: number): number {
  return offset + (graphemes(text.slice(offset))[0]?.length ?? 0);
}

export const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1;
export function lineEnd(text: string, offset: number): number {
  const newline = text.indexOf('\n', offset);
  return newline < 0 ? text.length : newline;
}

/** Word characters include every letter and digit (ç, ğ, ı, İ, ö, ş, ü ...); `spaces` selects readline's unix-word-rubout. */
const WORD = /[\p{L}\p{N}_]/u;
const SPACE = /\s/u;
export function wordLeft(text: string, offset: number, spaces = false): number {
  const isWord = (cluster: string) => (spaces ? !SPACE.test(cluster) : WORD.test(cluster));
  const before = graphemes(text.slice(0, offset));
  let index = before.length;
  while (index > 0 && !isWord(before[index - 1]!)) index--;
  while (index > 0 && isWord(before[index - 1]!)) index--;
  return before.slice(0, index).join('').length;
}

export function wordRight(text: string, offset: number): number {
  const after = graphemes(text.slice(offset));
  let index = 0;
  while (index < after.length && !WORD.test(after[index]!)) index++;
  while (index < after.length && WORD.test(after[index]!)) index++;
  return offset + after.slice(0, index).join('').length;
}

/** Move one line up (-1) or down (+1) keeping the cell column; null when there is no line in that direction. */
export function verticalOffset(text: string, offset: number, direction: -1 | 1): number | null {
  const start = lineStart(text, offset);
  const column = displayWidth(text.slice(start, offset));
  const target = direction < 0 ? (start === 0 ? -1 : lineStart(text, start - 1)) : lineEnd(text, offset) + 1;
  if (target < 0 || target > text.length) return null;
  let at = target, width = 0;
  for (const cluster of graphemes(text.slice(target, lineEnd(text, target)))) {
    if (width + clusterWidth(cluster) > column) break;
    width += clusterWidth(cluster);
    at += cluster.length;
  }
  return at;
}

export interface DraftRow {
  readonly text: string;
  /** UTF-16 offset of this row's first character in the draft. */
  readonly start: number;
}

/** Split on newlines, then greedy-wrap by cells; a wide cluster is never split across rows. */
export function layoutRows(text: string, width: number): DraftRow[] {
  const cells = Math.max(2, Math.floor(width));
  const rows: DraftRow[] = [];
  let start = 0;
  for (const line of text.split('\n')) {
    let row = '', rowStart = start, used = 0;
    for (const cluster of graphemes(line)) {
      const size = clusterWidth(cluster);
      if (used > 0 && used + size > cells) {
        rows.push({ text: row, start: rowStart });
        rowStart += row.length; row = ''; used = 0;
      }
      row += cluster; used += size;
    }
    rows.push({ text: row, start: rowStart });
    start += line.length + 1;
  }
  return rows;
}

/** Row index that shows the caret: the last row starting at or before it (a wrapped row end belongs to the next row). */
export function caretRow(rows: readonly DraftRow[], cursor: number): number {
  let index = 0;
  for (let row = 0; row < rows.length; row++) if (rows[row]!.start <= cursor) index = row;
  return index;
}
