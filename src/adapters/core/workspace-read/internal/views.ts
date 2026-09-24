import { boundLine, sliceUtf8, splitLines } from './bounded.js';

// read_file views ported from the legacy terminal (7111): outline for big files, numbered line ranges with long-line elision,
// grep-style search. The leading meta line says what was returned, what was not and where to resume.

export type ReadFileMode = 'content' | 'outline' | 'search';
export interface ReadFileBudget { readonly maxTotalBytes: number; readonly maxBytesPerLine: number }
export interface ReadFileViewRequest {
  readonly mode: ReadFileMode; readonly startLine: number; readonly endLine: number | null; readonly lineByteOffset: number;
  readonly maxBytesPerLine: number | undefined; readonly outlineOffset: number; readonly pattern: string | null;
  readonly literal: boolean; readonly ignoreCase: boolean; readonly context: number; readonly maxMatches: number;
}

const LINE_SHARE_DIVISOR = 8, MIN_BYTES_PER_LINE = 96, META_RESERVE_BYTES = 384, LINE_NUMBER_WIDTH = 6, HEADING_TITLE_MAX_BYTES = 160;
const DEFAULT_SEARCH_MAX_MATCHES = 50, HARD_SEARCH_MAX_MATCHES = 500, HARD_SEARCH_CONTEXT = 10;
const num = (n: number) => String(n).padStart(LINE_NUMBER_WIDTH, ' ');

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
/** The per-line share defaults to 1/8 of the result cap (2 KiB at 16 KiB). */
export function resolveReadFileBudget(maxTotalBytes: number, maxBytesPerLine?: number): ReadFileBudget {
  const perLineDefault = Math.max(MIN_BYTES_PER_LINE, Math.floor(maxTotalBytes / LINE_SHARE_DIVISOR));
  return { maxTotalBytes, maxBytesPerLine: Math.min(clampInt(maxBytesPerLine, perLineDefault, MIN_BYTES_PER_LINE, maxTotalBytes), maxTotalBytes) };
}

/** Plain `{path}` is a bounded content view from line 1, never the whole unbounded file. Malformed values are ignored, not guessed. */
export function resolveReadFileViewRequest(args: Record<string, unknown>): ReadFileViewRequest {
  const positive = (raw: unknown, fallback: number) => { const n = Number(raw); return raw !== undefined && raw !== null && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback; };
  const nonNegative = (raw: unknown, fallback: number) => { const n = Number(raw); return raw !== undefined && raw !== null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback; };
  const pattern = typeof args['pattern'] === 'string' && args['pattern'].length > 0 ? args['pattern'] : null;
  const modeRaw = args['mode'];
  const mode: ReadFileMode = modeRaw === 'content' || modeRaw === 'outline' || modeRaw === 'search' ? modeRaw : pattern !== null ? 'search' : 'content';
  const endLine = args['endLine'] === undefined || args['endLine'] === null ? null : positive(args['endLine'], Number.NaN);
  const perLine = args['maxBytesPerLine'] === undefined || args['maxBytesPerLine'] === null ? undefined : positive(args['maxBytesPerLine'], Number.NaN);
  return { mode, startLine: positive(args['startLine'], 1), endLine: endLine !== null && Number.isNaN(endLine) ? null : endLine,
    lineByteOffset: nonNegative(args['lineByteOffset'], 0), maxBytesPerLine: perLine !== undefined && Number.isNaN(perLine) ? undefined : perLine,
    outlineOffset: positive(args['outlineOffset'], 1), pattern, literal: args['literal'] === true, ignoreCase: args['ignoreCase'] === true,
    context: Math.min(HARD_SEARCH_CONTEXT, nonNegative(args['context'], 0)), maxMatches: Math.min(HARD_SEARCH_MAX_MATCHES, positive(args['maxMatches'], DEFAULT_SEARCH_MAX_MATCHES)) };
}

/** Numbered, byte-bounded range; the first line that does not fit ends the slice and becomes `nextStartLine`. */
export function renderRangeView(text: string, req: ReadFileViewRequest, budget: ReadFileBudget): string {
  const lines = splitLines(text), totalLines = lines.length;
  const start = Math.min(req.startLine - 1, totalLines), end = req.endLine === null ? totalLines : Math.min(req.endLine, totalLines);
  const bodyBudget = Math.max(0, budget.maxTotalBytes - META_RESERVE_BYTES);
  const body: string[] = [];
  let used = 0, elidedLines = 0, cursor = start;
  while (cursor < end) {
    const bounded = boundLine(lines[cursor]!, cursor + 1, req.lineByteOffset, budget.maxBytesPerLine);
    const row = `${num(cursor + 1)}\t${bounded.text}`, rowBytes = Buffer.byteLength(row, 'utf8') + 1;
    if (used + rowBytes > bodyBudget && body.length > 0) break;
    if (used + rowBytes > bodyBudget) {
      // A single line larger than the body budget is shrunk, never dropped: the marker keeps the continuation exact.
      const shrunk = boundLine(lines[cursor]!, cursor + 1, req.lineByteOffset, Math.max(MIN_BYTES_PER_LINE, bodyBudget - LINE_NUMBER_WIDTH - 2));
      body.push(`${num(cursor + 1)}\t${shrunk.text}`); if (shrunk.elidedBytes > 0) elidedLines++; cursor++; break;
    }
    body.push(row); used += rowBytes; if (bounded.elidedBytes > 0) elidedLines++; cursor++;
  }
  const returned = body.length, hasMore = cursor < end, next = hasMore ? cursor + 1 : null;
  const meta = `[deckent] read_file: mode=range totalLines=${totalLines} range=${returned === 0 ? 'empty' : `${start + 1}-${start + returned}`}`
    + ` returned=${returned} hasMore=${hasMore}${next !== null ? ` nextStartLine=${next}` : ''} maxBytesPerLine=${budget.maxBytesPerLine}`
    + ` elidedLines=${elidedLines}${returned === 0 ? ` requestedStartLine=${req.startLine}` : ''}`;
  return [meta, ...body].join('\n');
}

/** Markdown ATX headings outside fenced code blocks. */
export function extractMarkdownHeadings(lines: readonly string[]): { line: number; level: number; title: string }[] {
  const headings: { line: number; level: number; title: string }[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, fenceMatch = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) { const marker = fenceMatch[1]![0]!; if (fence === null) fence = marker; else if (marker === fence) fence = null; continue; }
    if (fence !== null) continue;
    const match = /^\s{0,3}(#{1,6})[ \t]+(.*?)\s*#*\s*$/u.exec(line);
    if (match) headings.push({ line: i + 1, level: match[1]!.length, title: sliceUtf8(Buffer.from(match[2]!, 'utf8'), HEADING_TITLE_MAX_BYTES) });
  }
  return headings;
}

/** Headings with line numbers plus size and longest-line statistics: the first view to take of a big file. */
export function renderOutlineView(text: string, req: ReadFileViewRequest, budget: ReadFileBudget): string {
  const lines = splitLines(text), headings = extractMarkdownHeadings(lines);
  let longest: { line: number; bytes: number } | null = null, over = 0;
  for (let i = 0; i < lines.length; i++) {
    const bytes = Buffer.byteLength(lines[i]!, 'utf8');
    if (longest === null || bytes > longest.bytes) longest = { line: i + 1, bytes };
    if (bytes > budget.maxBytesPerLine) over++;
  }
  const bodyBudget = Math.max(0, budget.maxTotalBytes - META_RESERVE_BYTES), start = Math.min(Math.max(0, req.outlineOffset - 1), headings.length);
  const body: string[] = [];
  let used = 0, cursor = start;
  while (cursor < headings.length) {
    const h = headings[cursor]!, row = `${num(h.line)}\t${'#'.repeat(h.level)} ${h.title}`, rowBytes = Buffer.byteLength(row, 'utf8') + 1;
    if (used + rowBytes > bodyBudget) break;
    body.push(row); used += rowBytes; cursor++;
  }
  const shown = body.length, hasMore = cursor < headings.length;
  const meta = `[deckent] read_file: mode=outline bytes=${Buffer.byteLength(text, 'utf8')} totalLines=${lines.length}`
    + ` longestLine=${longest === null ? 'none' : `L${longest.line}:${longest.bytes}B`} linesOver=${over}(>${budget.maxBytesPerLine}B)`
    + ` headings=${headings.length} shown=${shown === 0 ? 'none' : `${start + 1}-${start + shown}`} hasMore=${hasMore}`
    + `${hasMore ? ` nextOutlineOffset=${cursor + 1}` : ''}${headings.length === 0 ? ' note=no-markdown-headings; use {startLine,endLine} or {pattern}' : ''}`;
  return [meta, ...body].join('\n');
}

export function compileSearchPattern(pattern: string, literal: boolean, ignoreCase: boolean): RegExp | null {
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') : pattern;
  try { return new RegExp(source, ignoreCase ? 'iu' : 'u'); } catch { return null; }
}

/** grep -n style search with bounded context; `nextStartLine` resumes right after the last shown match. */
export function renderSearchView(text: string, req: ReadFileViewRequest, budget: ReadFileBudget): string {
  const lines = splitLines(text), totalLines = lines.length, patternText = req.pattern ?? '';
  const re = patternText.length === 0 ? null : compileSearchPattern(patternText, req.literal, req.ignoreCase);
  if (re === null) return `[deckent] read_file: mode=search pattern=${JSON.stringify(patternText)} error=invalid-pattern totalLines=${totalLines} matches=0 shown=0 hasMore=false`;
  const bodyBudget = Math.max(0, budget.maxTotalBytes - META_RESERVE_BYTES), body: string[] = [];
  let used = 0, matches = 0, shown = 0, hasMore = false, next: number | null = null, lastEmitted = 0;
  for (let i = Math.max(0, req.startLine - 1); i < totalLines; i++) {
    if (!re.test(lines[i]!)) continue;
    matches++;
    if (shown >= req.maxMatches) { hasMore = true; next = i + 1; break; }
    const from = Math.max(i - req.context, lastEmitted), to = Math.min(totalLines - 1, i + req.context), block: string[] = [];
    if (body.length > 0 && from > lastEmitted) block.push('--');
    for (let j = from; j <= to; j++) block.push(`${num(j + 1)}${j === i ? ':' : '-'}\t${boundLine(lines[j]!, j + 1, req.lineByteOffset, budget.maxBytesPerLine).text}`);
    const blockText = block.join('\n'), bytes = Buffer.byteLength(blockText, 'utf8') + 1;
    if (used + bytes > bodyBudget) { hasMore = true; next = i + 1; break; }
    body.push(blockText); used += bytes; shown++; lastEmitted = to + 1;
  }
  const meta = `[deckent] read_file: mode=search pattern=${JSON.stringify(patternText)}${req.literal ? ' literal=true' : ''}${req.ignoreCase ? ' ignoreCase=true' : ''}`
    + ` totalLines=${totalLines} matches=${hasMore ? `${matches}+` : matches} shown=${shown} context=${req.context} hasMore=${hasMore}`
    + `${next !== null ? ` nextStartLine=${next}` : ''} maxBytesPerLine=${budget.maxBytesPerLine}`;
  return [meta, ...body].join('\n');
}

/** The rendered view is at most `budget.maxTotalBytes` by construction. */
export function renderReadFileView(text: string, req: ReadFileViewRequest, budget: ReadFileBudget): string {
  const effective = req.maxBytesPerLine !== undefined ? resolveReadFileBudget(budget.maxTotalBytes, req.maxBytesPerLine) : budget;
  return req.mode === 'outline' ? renderOutlineView(text, req, effective) : req.mode === 'search' ? renderSearchView(text, req, effective) : renderRangeView(text, req, effective);
}
