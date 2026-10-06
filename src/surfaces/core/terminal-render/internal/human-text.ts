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
  const hiddenCount = projection.hiddenCount + modelIngressHiddenCount(text);
  return { label: plainText(projection.spans), spans: projection.spans,
    ...(hiddenCount > 0 && hiddenLabel ? { hiddenNotice: fillTemplate(hiddenLabel, { count: hiddenCount }) } : {}) };
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

const INGRESS_NOTE = /\[hidden-unicode: (\d+) cp, [^,\]]+, [a-f0-9]{12}\]/g;
const INGRESS_WITHHELD = /hidden payload \((\d+) cp, [a-f0-9]{12}\)/g;
/** Count already produced by the model-ingress projection. This does not classify the field again. */
export function modelIngressHiddenCount(text: string): number {
  let count = 0;
  for (const match of text.matchAll(INGRESS_NOTE)) count += Number(match[1]);
  for (const match of text.matchAll(INGRESS_WITHHELD)) count += Number(match[1]);
  return count;
}
/** The existing catalog label, filled with a count the producer already wrote. This file does not look up a locale. */
export function modelIngressNotice(text: string, label: string | undefined): string | null {
  const count = modelIngressHiddenCount(text);
  return count > 0 && label ? fillTemplate(label, { count }) : null;
}

/** Display adapter only: marker.source stays in the classifier's custody and is never emitted. */
export function projectHiddenText(text: string, context: HiddenTextContext, style: SpanStyle = {}): HumanTextProjection {
  const classified = classifyHiddenText(text, context);
  const spans = classified.tokens.map(token => token.kind === 'text' ? span(token.source, style)
    : span(`<U+${token.codePoint.toString(16).toUpperCase().padStart(4, '0')}>`, { ...style, role: 'warning', hiddenCodePoint: token.codePoint }));
  return Object.freeze({ spans: Object.freeze(spans), hiddenCount: classified.hiddenCount });
}
