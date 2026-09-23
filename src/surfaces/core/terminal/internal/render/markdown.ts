import type { RenderGlyphs } from './glyphs.js';
import { HIGHLIGHT_START, highlightLine, languageOf, looksLikeDiff } from './highlight.js';
import { parseInline } from './inline.js';
import { line, span, wrapSpans, type RenderedLine } from './spans.js';
import { isTableSeparator, renderTable } from './table.js';
import { cells } from './text-width.js';

/**
 * Markdown → render model (behavior of legacy commands/chat-render renderMarkdown, without ANSI strings): headings,
 * emphasis, inline code, lists, block quotes, rules, fenced code with a language label and highlighting, width-fitted
 * tables and diff colouring. An unclosed fence renders as an open code block (the live tail of a streaming answer).
 */
export type MarkdownOptions = Readonly<{ width: number; glyphs: RenderGlyphs; codeLabel: string }>;

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

function renderCode(block: readonly string[], closed: boolean, options: MarkdownOptions): RenderedLine[] {
  const { glyphs, width } = options;
  const label = FENCE.exec(block[0] ?? '')?.[2] ?? '';
  const body = block.slice(1, closed ? -1 : undefined).map(text => text.replace(/\t/g, '    '));
  const language = languageOf(label) ?? (looksLikeDiff(body) ? 'diff' : null);
  const rail = [span(glyphs.codeRail, { role: 'accent' }), span(' ')];
  const inner = Math.max(8, width - cells(glyphs.codeRail) - 1);
  const out = [line([span(`${glyphs.codeTop} `, { role: 'accent' }), span(label || options.codeLabel, { role: 'code' })], [], false)];
  let state = HIGHLIGHT_START;
  for (const text of body) {
    const highlighted = highlightLine(language, text, state);
    state = highlighted.state;
    for (const part of text === '' ? [[]] : wrapSpans(highlighted.spans, inner)) out.push(line(part, rail, false));
  }
  if (closed) out.push(line([span(glyphs.codeBottom, { role: 'accent' })], [], false));
  return out;
}

function renderLine(text: string, options: MarkdownOptions): RenderedLine {
  const { glyphs } = options;
  if (text.trim() === '') return line([]);
  if (RULE.test(text)) return line([span(glyphs.horizontal.repeat(Math.max(3, Math.min(options.width, 40))), { role: 'accent' })], [], false);
  const heading = HEADING.exec(text);
  if (heading) return line(parseInline(heading[2]!, heading[1]!.length === 1 ? { bold: true, role: 'info' } : { bold: true }));
  const quote = QUOTE.exec(text);
  if (quote) return line(parseInline(quote[1]!), [span(glyphs.quote, { role: 'accent' }), span(' ')]);
  const bullet = BULLET.exec(text);
  if (bullet) return line(parseInline(bullet[2]!), [span(bullet[1]!), span(`${glyphs.bullet} `, { role: 'accent' })]);
  const ordered = ORDERED.exec(text);
  if (ordered) return line(parseInline(ordered[3]!), [span(ordered[1]!), span(`${ordered[2]} `, { role: 'accent' })]);
  return line(parseInline(text));
}

export function renderMarkdown(markdown: string, options: MarkdownOptions): RenderedLine[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: RenderedLine[] = [];
  let lastBlank = false;
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index]!;
    const fence = FENCE.exec(text);
    if (fence) {
      const marker = fence[1]!;
      let end = index + 1;
      while (end < lines.length && !(lines[end]!.trim().startsWith(marker) && /^(`+|~+)$/.test(lines[end]!.trim()))) end++;
      const closed = end < lines.length;
      out.push(...renderCode(lines.slice(index, closed ? end + 1 : end), closed, options));
      index = closed ? end : lines.length; lastBlank = false; continue;
    }
    if (text.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      let end = index + 2;
      while (end < lines.length && lines[end]!.includes('|') && lines[end]!.trim() !== '') end++;
      out.push(...renderTable(lines.slice(index, end), options.width, options.glyphs));
      index = end - 1; lastBlank = false; continue;
    }
    const blank = text.trim() === '';
    if (blank && lastBlank) continue;
    lastBlank = blank;
    out.push(renderLine(text, options));
  }
  return out;
}
