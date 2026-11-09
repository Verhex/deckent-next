import { fillTemplate, plainText } from '#surfaces/core/terminal-render-ink/index.js';
import { ArrowPicker } from '#surfaces/core/terminal-picker/index.js';
import { approvalRawPatternCount } from './card.js';
import type { ApprovalDecisionLabels, ApprovalDecisionLine, ApprovalDecisionProjection } from '#surfaces/core/approval-presentation/index.js';
function pickerDetails(fields: readonly ApprovalDecisionProjection[], labels: ApprovalDecisionLabels): string | undefined {
  const lines: string[] = [];
  for (const field of fields) {
    if (labels.hiddenCount && field.hiddenCount) lines.push(fillTemplate(labels.hiddenCount, { count: field.hiddenCount }));
    if (labels.credentialLikeCount && approvalRawPatternCount(field)) lines.push(fillTemplate(labels.credentialLikeCount, { count: approvalRawPatternCount(field) }));
  }
  return lines.length ? lines.join('\n') : undefined;
}

export function ApprovalProjectedPicker({ lines, labels, onSelect, onCancel, active }: {
  readonly lines: readonly ApprovalDecisionLine[]; readonly labels: ApprovalDecisionLabels;
  readonly onSelect: (index: number) => void; readonly onCancel: () => void; readonly active?: boolean;
}) {
  return <ArrowPicker rows={lines.map(row => plainText(row.spans))} styledRows={lines.map(row => row.spans)}
    details={lines.map(row => pickerDetails(row.fields, labels))} onSelect={onSelect} onCancel={onCancel} {...(active === undefined ? {} : { active })} />;
}
