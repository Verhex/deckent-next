import { Box, Text } from 'ink';
import { ArrowPicker, SpanText, fillTemplate, plainText, sliceSpans } from '#surfaces/core/terminal-render/index.js';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { ApprovalDecisionWarnings, approvalRawPatternCount } from './card.js';
import type { ApprovalDecisionLabels, ApprovalDecisionLine, ApprovalDecisionProjection, ApprovalCardParts } from './types.js';
import { approvalTemplateSpans } from './text.js';

/** Only completed projection spans/counters cross the renderer boundary. No context-selected mode or raw UI props. */
export function ApprovalProjectedNotice({ line, labels, error }: {
  readonly line: ApprovalDecisionLine; readonly labels: ApprovalDecisionLabels; readonly error: boolean;
}) {
  const palette = useWorklinePalette();
  return <Box flexDirection="column"><Text {...(error ? palette.error : palette.muted)}><SpanText spans={line.spans} /></Text>
    <ApprovalDecisionWarnings fields={line.fields} labels={labels} /></Box>;
}

function pickerDetails(fields: readonly ApprovalDecisionProjection[], labels: ApprovalDecisionLabels): string | undefined {
  const lines: string[] = [];
  for (const field of fields) {
    if (labels.hiddenCount && field.hiddenCount) lines.push(fillTemplate(labels.hiddenCount, { count: field.hiddenCount }));
    if (labels.credentialLikeCount && approvalRawPatternCount(field)) lines.push(fillTemplate(labels.credentialLikeCount, { count: approvalRawPatternCount(field) }));
  }
  return lines.length ? lines.join('\n') : undefined;
}

export function ApprovalProjectedPicker({ lines, labels, onSelect, onCancel }: {
  readonly lines: readonly ApprovalDecisionLine[]; readonly labels: ApprovalDecisionLabels;
  readonly onSelect: (index: number) => void; readonly onCancel: () => void;
}) {
  return <ArrowPicker rows={lines.map(row => plainText(row.spans))} styledRows={lines.map(row => row.spans)}
    details={lines.map(row => pickerDetails(row.fields, labels))} onSelect={onSelect} onCancel={onCancel} />;
}

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
