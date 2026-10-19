import { redactForRecord, terminalSafeText, type KnownSecretSnapshot } from '#platform/index.js';
import registry from './human.json' with { type: 'json' };

/**
 * A plain-text table for CLI lists (no Ink: the CLI start never loads the terminal UI stack). Columns keep their natural width when they fit;
 * otherwise shrinkable columns lose width, widest first, and their cells end in an ellipsis. When not even the minimum widths fit, each row
 * becomes `header: value` lines. A pipe gets natural widths (nothing cut, so `grep` sees whole values). No colour or escape sequence is
 * ever written, so NO_COLOR, `TERM=dumb` and pipes need no special case; ASCII terminals get ASCII rules and ellipses.
 */
export type CliTableColumn = Readonly<{ header: string; align?: 'left' | 'right'; shrink?: boolean }>;
export type CliTableStyle = Readonly<{ width: number; ascii: boolean }>;
const GAP = 2, MIN_CELL = 4;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]+$/u, PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const wide = (code: number) => (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3)
  || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
  || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd);
const clusterCells = (cluster: string) => ZERO.test(cluster) ? 0 : wide(cluster.codePointAt(0) ?? 0) ? 2 : 1;

/** Terminal cells of a line (the terminal renderer's rule: graphemes, wide CJK/emoji two cells). */
export function textCells(text: string): number {
  if (PRINTABLE_ASCII.test(text)) return text.length;
  let total = 0;
  for (const { segment } of SEGMENTER.segment(text)) total += clusterCells(segment);
  return total;
}

function cut(text: string, width: number, ellipsis: string): string {
  if (textCells(text) <= width) return text;
  const room = Math.max(0, width - textCells(ellipsis));
  let kept = '', used = 0;
  for (const { segment } of SEGMENTER.segment(text)) { const size = clusterCells(segment); if (used + size > room) break; kept += segment; used += size; }
  return kept + ellipsis;
}

/** A cell as shown: known secrets and credential patterns redacted over the whole value first, terminal controls removed, one line, bounded. */
export function safeCell(value: unknown, known?: KnownSecretSnapshot): string {
  const text = value === null || value === undefined ? '' : String(value);
  return cut(redactForRecord(terminalSafeText(redactForRecord(text, known)), known).replace(/\s+/gu, ' ').trim(), registry.table.cellMax, '…');
}

/** Style from the output stream and environment: TTY width (pipe: unbounded), ASCII on dumb/Linux-console/non-UTF-8 terminals. */
export function cliTableStyle(context: { readonly env?: NodeJS.ProcessEnv; readonly stdout?: unknown }): CliTableStyle {
  const env = context.env ?? process.env, stream = (context.stdout ?? process.stdout) as { isTTY?: boolean; columns?: number };
  const locale = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || '';
  const ascii = env['TERM'] === 'linux' || env['TERM'] === 'dumb' || (locale !== '' && !/utf-?8/iu.test(locale));
  return { width: stream.isTTY && stream.columns ? stream.columns : Number.POSITIVE_INFINITY, ascii };
}

function fit(natural: readonly number[], columns: readonly CliTableColumn[], width: number): number[] | null {
  const widths = [...natural], budget = width - GAP * (natural.length - 1);
  let excess = widths.reduce((sum, value) => sum + value, 0) - budget;
  while (excess > 0) {
    let widest = -1;
    for (let index = 0; index < widths.length; index++) if (columns[index]!.shrink !== false && widths[index]! > MIN_CELL && (widest < 0 || widths[index]! > widths[widest]!)) widest = index;
    if (widest < 0) return null;
    widths[widest]!--; excess--;
  }
  return widths;
}

export function renderCliTable(columns: readonly CliTableColumn[], rows: readonly (readonly unknown[])[], style: CliTableStyle, known?: KnownSecretSnapshot): string {
  const head = columns.map(column => safeCell(column.header));
  const body = rows.map(row => columns.map((_, index) => safeCell(row[index], known)));
  const natural = head.map((cell, index) => Math.max(textCells(cell), ...body.map(row => textCells(row[index]!))));
  const widths = fit(natural, columns, style.width), ellipsis = style.ascii ? '...' : '…';
  if (!widths) return body.map(row => row.map((cell, index) => `${head[index]}: ${cell}`).join('\n')).join('\n\n');
  const line = (cells: readonly string[]) => cells.map((cell, index) => {
    const shown = cut(cell, widths[index]!, ellipsis), pad = ' '.repeat(widths[index]! - textCells(shown));
    return columns[index]!.align === 'right' ? pad + shown : index === cells.length - 1 ? shown : shown + pad;
  }).join(' '.repeat(GAP));
  const header = line(head), rule = widths.map(value => (style.ascii ? '-' : '─').repeat(value)).join(' '.repeat(GAP));
  return [header, rule, ...body.map(line)].join('\n');
}
