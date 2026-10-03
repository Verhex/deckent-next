import { terminalSafeText } from '#platform/index.js';
import { cells, truncateEnd, truncateStart } from '#surfaces/core/terminal-render/index.js';

/**
 * Display primitives shared by the plain-text snapshot and the fullscreen view: a line is spans with a semantic role. Meaning never
 * rides on colour alone: every state cell carries a text marker, so NO_COLOR and pipes keep it (the role only adds emphasis).
 */
export type MonitorRole = 'accent' | 'muted' | 'error' | 'warning' | 'success' | 'info' | 'strong';
export interface MonitorSpan { readonly text: string; readonly role?: MonitorRole }
export type MonitorLine = readonly MonitorSpan[];
export interface MonitorColumn {
  readonly header: string;
  /** Lower stays longer: when the width cannot hold every column, the highest priorities drop first (never wrap or overflow). */
  readonly priority: number; readonly min: number; readonly max: number;
  /** `start` keeps the informative end (paths); `end` keeps the start (words, ids). */
  readonly cut?: 'start' | 'end';
  /** The sort key this column shows (the fullscreen view marks the active one with ▲/▼). */
  readonly sortKey?: MonitorSortKey;
}
export type MonitorSortKey = 'age' | 'state' | 'name';
/** What the `/` filter prefixes match: `s:` state or blocker words, `i:` install, `t:` task kind, `r:` Run id (lower-case text). */
export interface MonitorFacets { readonly state?: string; readonly install?: string; readonly kind?: string; readonly run?: string;
  /** The human state word a `g` state grouping heads its group with. */
  readonly stateLabel?: string }
export interface MonitorRow {
  readonly key: string; readonly cells: readonly MonitorSpan[]; readonly detail: () => readonly MonitorLine[];
  /** H1 workers carry the same detail in once/slash text as Enter. */
  readonly detailInText?: boolean;
  readonly facets?: MonitorFacets;
  /** Sort values: age = epoch ms (newer is larger), state = rank (worse first), name = text. */
  readonly sort?: { readonly age?: number | null; readonly state?: number; readonly name?: string };
  /** What counts as a change for the one-refresh highlight (state, blocker, phase…); absent rows are never marked. */
  readonly signature?: string;
  /** Two-cell prefix: `+ ` new, `* ` changed since the previous snapshot (fullscreen only); default blank. */
  readonly mark?: string;
}
export type MonitorBlock =
  | { readonly kind: 'line'; readonly line: MonitorLine }
  | { readonly kind: 'table'; readonly columns: readonly MonitorColumn[]; readonly rows: readonly MonitorRow[]; readonly empty: string;
    /** Group heading of a row; rows arrive ordered by group and a heading line opens each group (columns stay aligned across groups). */
    readonly group?: (row: MonitorRow) => string };
/** One flattened screen line; `item` is the global index of the selectable row it shows. */
export interface MonitorFlatLine { readonly line: MonitorLine; readonly item?: number; readonly row?: MonitorRow }

const GAP = 2;
/**
 * THE guard (Fable REVISE #1): every span — and so every text line, Ink frame and `/monitor` notice — is built here, and its text is made
 * terminal-safe (no escape sequence, no control character; newline/tab become spaces). Worker output, events, activity, approval summaries,
 * diagnostics and other installs' ids and paths are untrusted.
 */
export const span = (text: string, role?: MonitorRole): MonitorSpan => {
  const safe = terminalSafeText(text).replace(/[\n\t]/g, ' ');
  return role ? { text: safe, role } : { text: safe };
};
export const lineText = (line: MonitorLine) => line.map(part => part.text).join('');

/** Cuts a line to `width` display cells (the last guard against overflow), keeping roles. */
export function clipLine(line: MonitorLine, width: number, ellipsis: string): MonitorLine {
  if (cells(lineText(line)) <= width) return line;
  const out: MonitorSpan[] = [];
  let used = 0;
  for (const part of line) {
    const size = cells(part.text), left = Math.max(0, width - used);
    if (used + size <= width - cells(ellipsis)) { out.push(part); used += size; continue; }
    // This span is where the line ends: cut it so the ellipsis still fits and marks the cut.
    out.push(span(size > left ? truncateEnd(part.text, left, ellipsis) : truncateEnd(part.text, Math.max(0, left - cells(ellipsis)), '') + ellipsis, part.role));
    break;
  }
  return out;
}

/**
 * Column fitting: every visible column first gets its readable minimum, the highest `priority` numbers drop while those minimums do not
 * fit, and the cells left over go to the columns in priority order up to their natural width. While the identifying column (lowest
 * priority number) would still be cut, droppable columns (priority >= 4) go first: a whole Run id beats a last-activity column.
 */
function fit(columns: readonly MonitorColumn[], rows: readonly MonitorRow[], width: number): { visible: number[]; widths: number[] } {
  const natural = columns.map((column, index) => Math.min(column.max, Math.max(cells(column.header), ...rows.map(row => cells(row.cells[index]?.text ?? '')))));
  const order = columns.map((_, index) => index).sort((a, b) => columns[a]!.priority - columns[b]!.priority || a - b);
  const floor = (index: number) => Math.min(columns[index]!.min, natural[index]!);
  const layout = (chosen: readonly number[]) => {
    const kept: number[] = [];
    let used = 0;
    for (const index of chosen) {
      const need = floor(index) + (kept.length ? GAP : 0);
      if (kept.length && used + need > width) break;
      kept.push(index); used += need;
    }
    const widths = new Map(kept.map(index => [index, floor(index)]));
    let left = width - used;
    for (const index of kept) { const take = Math.min(left, natural[index]! - widths.get(index)!); widths.set(index, widths.get(index)! + take); left -= take; }
    return { kept, widths };
  };
  let chosen = order, result = layout(chosen);
  while (result.widths.get(chosen[0]!)! < natural[chosen[0]!]! && columns[chosen.at(-1)!]!.priority >= 4 && chosen.length > 1) {
    chosen = chosen.slice(0, -1); result = layout(chosen);
  }
  const visible = columns.map((_, index) => index).filter(index => result.widths.has(index));
  return { visible, widths: visible.map(index => result.widths.get(index)!) };
}

function cellText(text: string, width: number, cut: 'start' | 'end', ellipsis: string): string {
  const shown = cut === 'start' ? truncateStart(text, width, ellipsis) : truncateEnd(text, width, ellipsis);
  return shown + ' '.repeat(Math.max(0, width - cells(shown)));
}

/** Blocks → screen lines at `width`; table rows become selectable items in order and are fitted (never wider than `width`). */
export function flattenBlocks(blocks: readonly MonitorBlock[], width: number, ellipsis: string): MonitorFlatLine[] {
  const out: MonitorFlatLine[] = [];
  let item = 0;
  for (const block of blocks) {
    // Sentences are not cut here: the text snapshot wraps them and the fullscreen view clips every screen line itself.
    if (block.kind === 'line') { out.push({ line: block.line }); continue; }
    if (!block.rows.length) { out.push({ line: [span(`  ${block.empty}`, 'muted')] }); continue; }
    const { visible, widths } = fit(block.columns, block.rows, Math.max(1, width - 2));
    const render = (parts: readonly MonitorSpan[], header: boolean): MonitorLine => {
      const line: MonitorSpan[] = [span('  ')];
      visible.forEach((index, position) => {
        const last = position === visible.length - 1, part = parts[index] ?? span('');
        const text = cellText(part.text, widths[position]!, block.columns[index]!.cut ?? 'end', ellipsis);
        line.push(span(last ? text.trimEnd() : text, header ? 'muted' : part.role));
        if (!last) line.push(span(' '.repeat(GAP)));
      });
      return clipLine(line, width, ellipsis);
    };
    out.push({ line: render(block.columns.map(column => span(column.header)), true) });
    let group: string | null = null;
    for (const row of block.rows) {
      const label = block.group?.(row) ?? null;
      if (label !== null && label !== group) { group = label; out.push({ line: clipLine([span(` ${label}`, 'accent')], width, ellipsis) }); }
      const line = render(row.cells, false);
      out.push({ line: row.mark ? [span(row.mark, 'accent'), ...line.slice(1)] : line, item: item++, row });
    }
  }
  return out;
}
