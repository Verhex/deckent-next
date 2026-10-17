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

/** Printable ASCII is one grapheme and one cell per code unit: the common case skips segmentation (monitor snapshots measure thousands of lines). */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/, JOINS_PREVIOUS = /^[\p{M}\p{Cf}]/u;
export function cells(text: string): number {
  if (PRINTABLE_ASCII.test(text)) return text.length;
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
  // Widths add up token by token, so each token is measured once instead of re-measuring the line; a token opening with a mark or format
  // character can join the previous grapheme and is measured with the line, exactly as before.
  let line = '', used = 0;
  for (const token of text.split(/(\s+)/)) {
    if (token === '') continue;
    const width = JOINS_PREVIOUS.test(token) ? cells(line + token) - used : cells(token);
    if (used + width <= limit) { line += token; used += width; continue; }
    if (line.trim() !== '') lines.push(line.trimEnd());
    line = ''; used = 0;
    if (/^\s+$/.test(token)) continue;
    let chunk = '', chunkCells = 0;
    for (const cluster of graphemes(token)) {
      const w = graphemeCells(cluster);
      if (chunk !== '' && chunkCells + w > limit) { lines.push(chunk); chunk = ''; chunkCells = 0; }
      chunk += cluster; chunkCells += w;
    }
    line = chunk; used = chunkCells;
  }
  if (line !== '' || lines.length === 0) lines.push(line);
  return lines;
}

/** Display only: replace the complete home directory prefix, never a similarly named sibling. No filesystem resolution. */
export function shortenHomePath(path: string, home: string | undefined): string {
  if (!home) return path;
  const prefix = home.replace(/[\\/]+$/u, '');
  return path === prefix ? '~' : path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\`) ? `~${path.slice(prefix.length)}` : path;
}
