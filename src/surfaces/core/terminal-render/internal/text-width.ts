/** Terminal display-cell measurement (no dependency): graphemes via Intl.Segmenter, wide CJK/emoji count two cells. */
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u;
const EMOJI = /\p{Extended_Pictographic}/u;

function isWide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff)
    || (code >= 0x20000 && code <= 0x3fffd);
}

export function graphemes(text: string): string[] {
  return Array.from(SEGMENTER.segment(text), part => part.segment);
}

function graphemeCells(cluster: string): number {
  if (ZERO_WIDTH.test(cluster)) return 0;
  const code = cluster.codePointAt(0) ?? 0;
  if (isWide(code) || cluster.includes('️') || (EMOJI.test(cluster) && code >= 0x1f000)) return 2;
  return 1;
}

export function cells(text: string): number {
  let width = 0;
  for (const cluster of graphemes(text)) width += graphemeCells(cluster);
  return width;
}

/** Keeps the start of `text` within `width` cells, ending with `ellipsis` when cut. */
export function truncateEnd(text: string, width: number, ellipsis: string): string {
  if (cells(text) <= width) return text;
  const room = width - cells(ellipsis);
  if (room <= 0) return graphemes(ellipsis).slice(0, Math.max(0, width)).join('');
  let out = '', used = 0;
  for (const cluster of graphemes(text)) {
    const w = graphemeCells(cluster);
    if (used + w > room) break;
    out += cluster; used += w;
  }
  return out + ellipsis;
}

/** Keeps the end of `text` (the informative part of a path or id) within `width` cells. */
export function truncateStart(text: string, width: number, ellipsis: string): string {
  if (cells(text) <= width) return text;
  const room = width - cells(ellipsis);
  if (room <= 0) return graphemes(ellipsis).slice(0, Math.max(0, width)).join('');
  let out = '', used = 0;
  for (const cluster of graphemes(text).reverse()) {
    const w = graphemeCells(cluster);
    if (used + w > room) break;
    out = cluster + out; used += w;
  }
  return ellipsis + out;
}

/** Word-aware wrap into lines of at most `width` cells; words longer than a line are cut by grapheme. */
export function wrapCells(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  if (cells(text) <= limit) return [text];
  const lines: string[] = [];
  let line = '';
  for (const token of text.split(/(\s+)/)) {
    if (token === '') continue;
    if (cells(line + token) <= limit) { line += token; continue; }
    if (line.trim() !== '') lines.push(line.trimEnd());
    line = '';
    if (/^\s+$/.test(token)) continue;
    let chunk = '';
    for (const cluster of graphemes(token)) {
      if (chunk !== '' && cells(chunk + cluster) > limit) { lines.push(chunk); chunk = ''; }
      chunk += cluster;
    }
    line = chunk;
  }
  if (line !== '' || lines.length === 0) lines.push(line);
  return lines;
}
