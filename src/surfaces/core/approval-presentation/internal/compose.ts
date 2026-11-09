import { plainText, sliceSpans } from '#surfaces/core/terminal-render/index.js';
import type { ApprovalDecisionProjection, ApprovalDecisionLine, ApprovalCardParts } from './types.js';
import { approvalTemplateSpans } from './text.js';

/** All interpolated display fields have completed projection before this catalog-only composition. */
export function approvalTemplateLine(template: string, values: Readonly<Record<string, ApprovalDecisionProjection | string | number>>): ApprovalDecisionLine {
  const spans = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === 'object' ? value.spans : value]));
  return { spans: approvalTemplateSpans(template, spans), fields: Object.values(values).filter((value): value is ApprovalDecisionProjection => typeof value === 'object') };
}

function splitField(field: ApprovalDecisionProjection, maxLines?: number, more?: string): ApprovalDecisionLine[] {
  const parts = plainText(field.spans).split('\n'); let start = 0;
  const lines: ApprovalDecisionLine[] = parts.slice(0, maxLines).map(part => {
    const spans = sliceSpans(field.spans, start, start + part.length); start += part.length + 1; return { spans, fields: [] };
  });
  // Warn once for the complete received field, even when its evidence lies beyond the existing preview cap.
  if (lines[0]) lines[0] = { ...lines[0], fields: [field] };
  if (maxLines !== undefined && parts.length > maxLines && more) lines.push(approvalTemplateLine(more, { count: parts.length - maxLines }));
  return lines;
}

export function assembleApprovalCard(parts: ApprovalCardParts): readonly ApprovalDecisionLine[] {
  return [...(parts.subject ? [parts.subject] : []), ...splitField(parts.summary), parts.risk,
    ...(parts.preview ? splitField(parts.preview, 24, parts.previewMore) : []), ...(parts.covers ? [parts.covers] : []),
    parts.expiry, ...(parts.assurance ? [parts.assurance] : [])];
}
