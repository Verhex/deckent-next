import { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { scopedDecisionKey, type StandingScope } from '#surfaces/core/terminal-kit/index.js';
import { HiddenTextNotice, SpanText } from '#surfaces/core/terminal-render/index.js';
import { fillTemplate } from '#surfaces/core/terminal-render/index.js';
import type { ApprovalDecisionProjection, ApprovalDecisionLabels, ApprovalDecisionLine } from './types.js';

export const approvalRawPatternCount = (field: ApprovalDecisionProjection) => field.patternMatches.reduce((count, match) => count + match.count, 0);

/** Each counter belongs to its original transported field, never a second display redaction pass. */
export function ApprovalDecisionWarnings({ fields, labels }: { readonly fields: readonly ApprovalDecisionProjection[]; readonly labels: ApprovalDecisionLabels }) {
  const palette = useWorklinePalette();
  return <>{fields.map((field, index) => <Box key={index} flexDirection="column">
    <HiddenTextNotice count={field.hiddenCount} label={labels.hiddenCount} />
    {labels.credentialLikeCount && approvalRawPatternCount(field) > 0
      ? <Text {...palette.warning}>{fillTemplate(labels.credentialLikeCount, { count: approvalRawPatternCount(field) })}</Text> : null}
  </Box>)}</>;
}

export interface DecisionCardProps {
  readonly title: ApprovalDecisionLine;
  readonly projectedLines: readonly ApprovalDecisionLine[];
  readonly decisionLabels?: ApprovalDecisionLabels;
  readonly prompt: string;
  readonly pendingText: string;
  /** Shared controller owns pending/retry when supplied; standalone cards retain their one-shot behavior. */
  readonly pending?: boolean;
  /** Standing scopes this card offers (`s` session, `a` always); none = the plain y/N card. */
  readonly scopes?: readonly StandingScope[];
  /** Called once; later keys are ignored while the decision is recorded. */
  readonly onDecide: (yes: boolean, standing?: StandingScope) => void;
}

/** Modal y/N card in the dynamic region; owns input while mounted (the composer is inactive). */
export function DecisionCard({ title, projectedLines, decisionLabels = {}, prompt, pendingText, pending: controlledPending, scopes = [], onDecide }: DecisionCardProps) {
  const ink = useWorklinePalette();
  const decided = useRef(false);
  const [pending, setPending] = useState(false);
  useInput((input, key) => {
    if (controlledPending ?? decided.current) return;
    const answer = scopedDecisionKey(input, key, scopes);
    if (answer === null) return;
    if (controlledPending === undefined) { decided.current = true; setPending(true); }
    onDecide(answer.yes, answer.standing);
  });
  return (
    <Box flexDirection="column" borderStyle="double" {...(ink.accent.color ? { borderColor: ink.accent.color } : {})} paddingX={1}>
      <Text {...ink.accent}><SpanText spans={title.spans} /></Text><ApprovalDecisionWarnings fields={title.fields} labels={decisionLabels} />
      {projectedLines.map((line, index) => <Box key={`decision:${index}`} flexDirection="column">
        <Text><SpanText spans={line.spans} /></Text><ApprovalDecisionWarnings fields={line.fields} labels={decisionLabels} />
      </Box>)}
      <Text {...ink.muted}>{(controlledPending ?? pending) ? pendingText : prompt}</Text>
    </Box>
  );
}
