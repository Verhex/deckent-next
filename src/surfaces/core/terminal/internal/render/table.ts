import type { RenderGlyphs } from './glyphs.js';
import { parseInline } from './inline.js';
import { line, padSpans, span, spanCells, wrapSpans, type RenderedLine, type Span } from './spans.js';

/**
 * Markdown table → boxed rows fitted to the terminal width (legacy chat-render renderTable, plus column wrapping).
 * Columns keep their natural width when it fits; otherwise the widest columns shrink and their cells wrap. When not even
 * three cells per column fit, rows degrade to `• header: value` lines (legacy narrow-terminal fallback).
 */
type Align = 'left' | 'right' | 'center';
const MIN_COLUMN = 3;

export const isTableSeparator = (text: string): boolean => text.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(text);

function splitRow(text: string): string[] {
  return text.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

/** Fair share: every column gets up to an equal slice; slack from narrow columns goes to the ones still wanting more. */
function fitColumns(natural: readonly number[], available: number): number[] {
  const widths = natural.map(() => 0);
  let left = available, open = natural.map((_, index) => index);
  while (left > 0 && open.length > 0) {
    const share = Math.max(1, Math.floor(left / open.length));
    for (const index of open) {
      const take = Math.min(share, natural[index]! - widths[index]!, left);
      widths[index]! += take; left -= take;
    }
    open = open.filter(index => widths[index]! < natural[index]!);
  }
  return widths;
}

export function renderTable(rows: readonly string[], width: number, glyphs: RenderGlyphs): RenderedLine[] {
  const header = splitRow(rows[0] ?? '');
  const aligns: Align[] = splitRow(rows[1] ?? '').map(cell => cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : 'left');
  const count = header.length;
  const body = rows.slice(2).map(splitRow).map(cellsOf => Array.from({ length: count }, (_, index) => cellsOf[index] ?? ''));
  const parse = (text: string, bold: boolean): Span[] => parseInline(text, bold ? { bold: true } : {});
  const head = header.map(text => parse(text, true));
  const grid = body.map(cellsOf => cellsOf.map(text => parse(text, false)));
  const natural = head.map((cell, index) => Math.max(1, spanCells(cell), ...grid.map(row => spanCells(row[index]!))));
  const overhead = 3 * count + 1;
  if (width - overhead < MIN_COLUMN * count) {
    const bullet = [span(`${glyphs.bullet} `, { role: 'muted' })], hang = [span(' '.repeat(glyphs.bullet.length + 1))];
    return grid.flatMap(row => row.map((cell, index) => line([...head[index]!, span(': '), ...cell], index === 0 ? bullet : hang)));
  }
  const fits = natural.reduce((sum, value) => sum + value, 0) + overhead <= width;
  const widths = fits ? natural : fitColumns(natural, width - overhead);
  const edge = span(glyphs.table.edge, { role: 'accent' });
  const rule = ([left, middle, right]: readonly [string, string, string]) =>
    line([span(left + widths.map(value => glyphs.horizontal.repeat(value + 2)).join(middle) + right, { role: 'accent' })], [], false);
  const rowLines = (cellsOf: readonly Span[][]): RenderedLine[] => {
    const wrapped = cellsOf.map((cell, index) => wrapSpans(cell, widths[index]!));
    const height = Math.max(...wrapped.map(parts => parts.length));
    return Array.from({ length: height }, (_, lineIndex) => line([edge, ...wrapped.flatMap((parts, index) =>
      [span(' '), ...padSpans(parts[lineIndex] ?? [], widths[index]!, aligns[index] ?? 'left'), span(' '), edge])], [], false));
  };
  return [rule(glyphs.table.top), ...rowLines(head), rule(glyphs.table.mid), ...grid.flatMap(rowLines), rule(glyphs.table.bottom)];
}
