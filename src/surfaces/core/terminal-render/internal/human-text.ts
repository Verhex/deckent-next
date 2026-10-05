import { classifyHiddenText, type HiddenTextContext } from '#domain/index.js';
import { redactForRecord, terminalSafeText, type KnownSecretSnapshot } from '#platform/index.js';
import { parseInline } from './inline.js';
import { renderMarkdown, type MarkdownOptions } from './markdown.js';
import type { RenderedLine } from './spans.js';
import { plainText } from './spans.js';
import { fillTemplate } from './status-row.js';
import { span, type Span, type SpanStyle } from './spans.js';

export type HumanTextProjector = (text: string, context: HiddenTextContext, style?: SpanStyle) => Span[];
export type HumanTextProjection = Readonly<{ spans: readonly Span[]; hiddenCount: number }>;

/** Always redact the complete transported field before callers make a display-only cut or parse it. */
export function humanRecordText(text: string, known?: KnownSecretSnapshot): string {
  // Removing terminal controls can join previously separated pieces into a known value.
  return redactForRecord(terminalSafeText(redactForRecord(text, known)), known);
}

export function projectHumanText(text: string, context: HiddenTextContext, known?: KnownSecretSnapshot, style: SpanStyle = {}): HumanTextProjection {
  return projectHiddenText(humanRecordText(text, known), context, style);
}

export function projectHumanPickerText(text: string, known?: KnownSecretSnapshot, hiddenLabel?: string): Readonly<{ label: string; spans: readonly Span[]; hiddenNotice?: string }> {
  const projection = projectHumanText(text, 'prose', known);
  return { label: plainText(projection.spans), spans: projection.spans,
    ...(projection.hiddenCount > 0 && hiddenLabel ? { hiddenNotice: fillTemplate(hiddenLabel, { count: projection.hiddenCount }) } : {}) };
}

function countedProjector(): { project: HumanTextProjector; count: () => number } {
  let hiddenCount = 0;
  return { project(text, context, style) { const result = projectHiddenText(text, context, style); hiddenCount += result.hiddenCount; return [...result.spans]; }, count: () => hiddenCount };
}

export function projectHumanInline(text: string, known?: KnownSecretSnapshot): HumanTextProjection {
  const counter = countedProjector();
  const spans = parseInline(humanRecordText(text, known), {}, counter.project);
  return Object.freeze({ spans: Object.freeze(spans), hiddenCount: counter.count() });
}

export function renderHumanMarkdown(text: string, options: MarkdownOptions, known?: KnownSecretSnapshot): Readonly<{ lines: readonly RenderedLine[]; hiddenCount: number }> {
  const counter = countedProjector();
  const lines = renderMarkdown(humanRecordText(text, known), { ...options, projectText: counter.project });
  return Object.freeze({ lines: Object.freeze(lines), hiddenCount: counter.count() });
}

/** Display adapter only: marker.source stays in the classifier's custody and is never emitted. */
export function projectHiddenText(text: string, context: HiddenTextContext, style: SpanStyle = {}): HumanTextProjection {
  const classified = classifyHiddenText(text, context);
  const spans = classified.tokens.map(token => token.kind === 'text' ? span(token.source, style)
    : span(`<U+${token.codePoint.toString(16).toUpperCase().padStart(4, '0')}>`, { ...style, role: 'warning', hiddenCodePoint: token.codePoint }));
  return Object.freeze({ spans: Object.freeze(spans), hiddenCount: classified.hiddenCount });
}
