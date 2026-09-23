import { cells, wrapCells } from './text-width.js';

/**
 * Pure render model: styled spans with semantic palette roles and attribute flags, no ANSI and no Ink. The view maps
 * roles to the active palette (the `none` tier maps every role and attribute to nothing), so plain text is `spans.text`.
 */
export type SpanRole = 'accent' | 'muted' | 'code' | 'link' | 'info' | 'success' | 'warning' | 'error';
export type Span = Readonly<{ text: string; role?: SpanRole; bold?: boolean; italic?: boolean; strike?: boolean }>;
/** `prefix` stays fixed (bullet, rail, quote bar); `body` wraps under it with a hanging indent when `wrap` is true. */
export type RenderedLine = Readonly<{ prefix: readonly Span[]; body: readonly Span[]; wrap: boolean }>;

export type SpanStyle = Omit<Span, 'text'>;

export function span(text: string, style: SpanStyle = {}): Span {
  return Object.freeze({ text, ...style });
}

export function line(body: readonly Span[], prefix: readonly Span[] = [], wrap = true): RenderedLine {
  return Object.freeze({ prefix: Object.freeze([...prefix]), body: Object.freeze([...body]), wrap });
}

export function plainText(spans: readonly Span[]): string {
  return spans.map(part => part.text).join('');
}

export function spanCells(spans: readonly Span[]): number {
  return cells(plainText(spans));
}

/** The spans covering UTF-16 offsets [start, end) of their joined text. */
export function sliceSpans(spans: readonly Span[], start: number, end: number): Span[] {
  const out: Span[] = [];
  let offset = 0;
  for (const part of spans) {
    const from = Math.max(start, offset), to = Math.min(end, offset + part.text.length);
    if (from < to) out.push({ ...part, text: part.text.slice(from - offset, to - offset) });
    offset += part.text.length;
  }
  return out;
}

/** Word-aware wrap of styled spans into lines of at most `width` cells (styles survive the breaks). */
export function wrapSpans(spans: readonly Span[], width: number): Span[][] {
  const plain = plainText(spans);
  let cursor = 0;
  return wrapCells(plain, width).map(text => {
    const start = text === '' ? cursor : plain.indexOf(text, cursor);
    cursor = start + text.length;
    return sliceSpans(spans, start, cursor);
  });
}

/** Pads spans with spaces to exactly `width` cells in the given alignment. */
export function padSpans(spans: readonly Span[], width: number, align: 'left' | 'right' | 'center' = 'left'): Span[] {
  const gap = Math.max(0, width - spanCells(spans));
  if (gap === 0) return [...spans];
  const left = align === 'right' ? gap : align === 'center' ? gap >> 1 : 0;
  return [...(left ? [span(' '.repeat(left))] : []), ...spans, ...(gap - left ? [span(' '.repeat(gap - left))] : [])];
}

/** Renders lines to plain text (the `none` palette tier and golden tests). */
export function renderedText(lines: readonly RenderedLine[]): string {
  return lines.map(entry => plainText(entry.prefix) + plainText(entry.body)).join('\n');
}
