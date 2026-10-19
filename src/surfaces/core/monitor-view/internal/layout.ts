import { terminalSafeText } from '#platform/index.js';
import { cells, truncateEnd, truncateStart, wrapCells } from '#surfaces/core/terminal-render/index.js';

/**
 * Display primitives shared by the plain-text snapshot and the fullscreen view: a line is spans with a semantic role. Meaning never
 * rides on colour alone: every state cell carries a text marker, so NO_COLOR and pipes keep it (the role only adds emphasis).
 * The roles are Workline palette roles: `sectionHeader` and `keyLabel` are bold headings, `windowBorder` the frame lines (PB-MON-UX).
 */
export type MonitorRole = 'accent' | 'muted' | 'error' | 'warning' | 'success' | 'info' | 'strong' | 'sectionHeader' | 'keyLabel' | 'windowBorder';
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
  /** Essential collapsed-row context wraps at display-cell width; it never becomes another selectable item. */
  readonly context?: readonly MonitorLine[];
  readonly facets?: MonitorFacets;
  /** Sort values: age = epoch ms (newer is larger), state = rank (worse first), name = text. */
  readonly sort?: { readonly age?: number | null; readonly state?: number; readonly name?: string };
  /** What counts as a change for the one-refresh highlight (state, blocker, phase…); absent rows are never marked. */
  readonly signature?: string;
  /** Two-cell prefix: `+ ` new, `* ` changed since the previous snapshot (fullscreen only); default blank. */
  readonly mark?: string;
}
/** One label → value row of a framed card (Kurulumlar); a section is a run of entries between two separator lines. */
export interface MonitorCardEntry { readonly label: MonitorSpan; readonly value: MonitorLine }
export type MonitorBlock =
  | { readonly kind: 'line'; readonly line: MonitorLine }
  | { readonly kind: 'table'; readonly columns: readonly MonitorColumn[]; readonly rows: readonly MonitorRow[]; readonly empty: string;
    /** Group heading of a row; rows arrive ordered by group and a heading line opens each group (columns stay aligned across groups). */
    readonly group?: (row: MonitorRow) => string }
  /** A framed label/value card under a heading line; with `row` the heading is a selectable item (Enter opens the row's detail). */
  | { readonly kind: 'card'; readonly head: MonitorLine; readonly sections: readonly (readonly MonitorCardEntry[])[]; readonly row?: MonitorRow };
/** One flattened screen line; `item` is the global index of the selectable row it shows. */
export interface MonitorFlatLine { readonly line: MonitorLine; readonly item?: number; readonly row?: MonitorRow }

/** Frame glyphs (PB-MON-UX): box drawing, and `+ - |` when Unicode is not trusted (ASCII). */
interface Frame { readonly h: string; readonly v: string; readonly top: readonly [string, string, string]; readonly mid: readonly [string, string, string];
  readonly bottom: readonly [string, string, string] }
const BOX: Frame = { h: '─', v: '│', top: ['┌', '┬', '┐'], mid: ['├', '┼', '┤'], bottom: ['└', '┴', '┘'] };
const PLAIN: Frame = { h: '-', v: '|', top: ['+', '+', '+'], mid: ['+', '+', '+'], bottom: ['+', '+', '+'] };
/** Cells between two framed columns (` │ `) and the outer frame plus the row's two-cell prefix (`  │ ` … ` │`). */
const GAP = 3, OUTER = 6;

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
  return { visible, widths: visible.map(index => Math.max(1, result.widths.get(index)!)) };
}

function cellText(text: string, width: number, cut: 'start' | 'end', ellipsis: string): string {
  const shown = cut === 'start' ? truncateStart(text, width, ellipsis) : truncateEnd(text, width, ellipsis);
  return shown + ' '.repeat(Math.max(0, width - cells(shown)));
}

/** A horizontal frame line over column widths (`┌──┬──┐`); `label` is written into it from the left (`├─ Group ─┼──┤`). */
function rule(widths: readonly number[], ends: readonly [string, string, string], frame: Frame, label?: string): MonitorLine {
  const plain = `${ends[0]}${widths.map(width => frame.h.repeat(width + 2)).join(ends[1])}${ends[2]}`;
  if (!label) return [span('  '), span(plain, 'windowBorder')];
  const text = truncateEnd(label, Math.max(0, cells(plain) - 6), '');
  const head = `${ends[0]}${frame.h} `, rest = [...plain].slice(cells(head) + cells(text) + 1);
  return [span('  '), span(head, 'windowBorder'), span(text, 'sectionHeader'), span(` ${rest.join('')}`, 'windowBorder')];
}

/** One framed table: top rule, bold header, header rule, rows (group headings as labelled rules, context inside the frame), bottom rule. */
function tableLines(block: Extract<MonitorBlock, { kind: 'table' }>, width: number, ellipsis: string, frame: Frame, next: () => number): MonitorFlatLine[] {
  const out: MonitorFlatLine[] = [];
  const { visible, widths } = fit(block.columns, block.rows, Math.max(1, width - OUTER));
  // Row context (a held worker's "who is waiting") is read whole: the last column widens, up to the screen, so it wraps as little as possible.
  const context = Math.max(0, ...block.rows.flatMap(row => (row.context ?? []).map(line => cells(lineText(line)))));
  const natural = widths.reduce((sum, value) => sum + value, 0) + GAP * (widths.length - 1);
  if (context > natural) widths[widths.length - 1]! += Math.min(context, Math.max(1, width - OUTER)) - Math.min(natural, Math.max(1, width - OUTER));
  const inner = widths.reduce((sum, value) => sum + value, 0) + GAP * (widths.length - 1);
  const border = (text: string) => span(text, 'windowBorder');
  const render = (parts: readonly MonitorSpan[], header: boolean): MonitorLine => {
    const line: MonitorSpan[] = [span('  '), border(`${frame.v} `)];
    visible.forEach((index, position) => {
      const part = parts[index] ?? span('');
      line.push(span(cellText(part.text, widths[position]!, block.columns[index]!.cut ?? 'end', ellipsis), header ? 'keyLabel' : part.role));
      line.push(border(position === visible.length - 1 ? ` ${frame.v}` : ` ${frame.v} `));
    });
    return clipLine(line, width, ellipsis);
  };
  out.push({ line: rule(widths, frame.top, frame) }, { line: render(block.columns.map(column => span(column.header)), true) }, { line: rule(widths, frame.mid, frame) });
  let group: string | null = null;
  for (const row of block.rows) {
    const label = block.group?.(row) ?? null;
    if (label !== null && label !== group) {
      // The first group heading replaces the header rule's position (no doubled rule under the header).
      if (group !== null) out.push({ line: rule(widths, frame.mid, frame, label) }); else out[2] = { line: rule(widths, frame.mid, frame, label) };
      group = label;
    }
    const line = render(row.cells, false);
    out.push({ line: row.mark ? [span(row.mark, 'accent'), ...line.slice(1)] : line, item: next(), row });
    for (const context of row.context ?? []) {
      const role = context.find(part => part.role)?.role;
      for (const text of wrapCells(lineText(context), Math.max(1, inner))) {
        out.push({ line: clipLine([span('  '), border(`${frame.v} `), span(text + ' '.repeat(Math.max(0, inner - cells(text))), role), border(` ${frame.v}`)], width, ellipsis) });
      }
    }
  }
  out.push({ line: rule(widths, frame.bottom, frame) });
  return out;
}

/** A framed label/value card; a value wider than its column wraps inside the frame (the label stays on the first line). */
function cardLines(block: Extract<MonitorBlock, { kind: 'card' }>, width: number, ellipsis: string, frame: Frame, item: number | undefined): MonitorFlatLine[] {
  const entries = block.sections.flat(), border = (text: string) => span(text, 'windowBorder');
  const mark = block.row?.mark, head: MonitorFlatLine = { line: clipLine([mark ? span(mark, 'accent') : span('  '), ...block.head], width, ellipsis),
    ...(item !== undefined && block.row ? { item, row: block.row } : {}) };
  if (!entries.length) return [head];
  const room = Math.max(2, width - OUTER - GAP);
  const label = Math.min(Math.max(...entries.map(entry => cells(entry.label.text))), Math.max(1, Math.floor(room / 3)));
  const value = Math.max(1, Math.min(room - label, Math.max(...entries.map(entry => cells(lineText(entry.value))))));
  const out: MonitorFlatLine[] = [head, { line: rule([label, value], frame.top, frame) }];
  block.sections.filter(section => section.length).forEach((section, index) => {
    if (index) out.push({ line: rule([label, value], frame.mid, frame) });
    for (const entry of section) {
      const text = lineText(entry.value), role = entry.value.find(part => part.role)?.role;
      // A value that fits keeps its own roles; a wrapped one takes its first role (the marker at its start still carries the meaning).
      const parts: MonitorLine[] = cells(text) <= value ? [entry.value] : wrapCells(text, value).map(part => [span(part, role)]);
      parts.forEach((part, at) => out.push({ line: clipLine([span('  '), border(`${frame.v} `), span(cellText(at ? '' : entry.label.text, label, 'end', ellipsis), entry.label.role ?? 'keyLabel'),
        border(` ${frame.v} `), ...part, span(' '.repeat(Math.max(0, value - cells(lineText(part))))), border(` ${frame.v}`)], width, ellipsis) }));
    }
  });
  out.push({ line: rule([label, value], frame.bottom, frame) });
  return out;
}

/**
 * Blocks → screen lines at `width`; table rows (and card headings with a row) become selectable items in order. Tables and cards are
 * framed (box drawing, or `+-|` with `ascii`) and fitted, never wider than `width`.
 */
export function flattenBlocks(blocks: readonly MonitorBlock[], width: number, ellipsis: string, ascii = false): MonitorFlatLine[] {
  const out: MonitorFlatLine[] = [], frame = ascii ? PLAIN : BOX;
  let item = 0;
  const next = () => item++;
  for (const block of blocks) {
    // Sentences are not cut here: the text snapshot wraps them and the fullscreen view clips every screen line itself.
    if (block.kind === 'line') { out.push({ line: block.line }); continue; }
    if (block.kind === 'card') { out.push(...cardLines(block, width, ellipsis, frame, block.row ? next() : undefined)); continue; }
    if (!block.rows.length) { out.push({ line: [span(`  ${block.empty}`, 'muted')] }); continue; }
    out.push(...tableLines(block, width, ellipsis, frame, next));
  }
  return out;
}
