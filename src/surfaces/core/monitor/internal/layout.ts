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
}
export interface MonitorRow { readonly key: string; readonly cells: readonly MonitorSpan[]; readonly detail: () => readonly MonitorLine[] }
export type MonitorBlock =
  | { readonly kind: 'line'; readonly line: MonitorLine }
  | { readonly kind: 'table'; readonly columns: readonly MonitorColumn[]; readonly rows: readonly MonitorRow[]; readonly empty: string };
/** One flattened screen line; `item` is the global index of the selectable row it shows. */
export interface MonitorFlatLine { readonly line: MonitorLine; readonly item?: number; readonly row?: MonitorRow }

const GAP = 2;
export const span = (text: string, role?: MonitorRole): MonitorSpan => role ? { text, role } : { text };
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
    for (const row of block.rows) out.push({ line: render(row.cells, false), item: item++, row });
  }
  return out;
}
