import { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { scopedDecisionKey, type StandingScope } from './approval-watch.js';

export interface DecisionCardProps {
  readonly title: string;
  readonly lines: readonly string[];
  readonly prompt: string;
  readonly pendingText: string;
  /** Standing scopes this card offers (`s` session, `a` always); none = the plain y/N card. */
  readonly scopes?: readonly StandingScope[];
  /** Called once; later keys are ignored while the decision is recorded. */
  readonly onDecide: (yes: boolean, standing?: StandingScope) => void;
}

/** Modal y/N card in the dynamic region; owns input while mounted (the composer is inactive). */
export function DecisionCard({ title, lines, prompt, pendingText, scopes = [], onDecide }: DecisionCardProps) {
  const ink = useWorklinePalette();
  const decided = useRef(false);
  const [pending, setPending] = useState(false);
  useInput((input, key) => {
    if (decided.current) return;
    const answer = scopedDecisionKey(input, key, scopes);
    if (answer === null) return;
    decided.current = true;
    setPending(true);
    onDecide(answer.yes, answer.standing);
  });
  return (
    <Box flexDirection="column" borderStyle="double" {...(ink.accent.color ? { borderColor: ink.accent.color } : {})} paddingX={1}>
      <Text {...ink.accent}>{title}</Text>
      {lines.map((line, index) => <Text key={index}>{line}</Text>)}
      <Text {...ink.muted}>{pending ? pendingText : prompt}</Text>
    </Box>
  );
}
