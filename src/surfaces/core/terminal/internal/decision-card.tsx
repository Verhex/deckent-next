import { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { decisionKey } from './approval-watch.js';

export interface DecisionCardProps {
  readonly title: string;
  readonly lines: readonly string[];
  readonly prompt: string;
  readonly pendingText: string;
  /** Called once; later keys are ignored while the decision is recorded. */
  readonly onDecide: (yes: boolean) => void;
}

/** Modal y/N card in the dynamic region; owns input while mounted (the composer is inactive). */
export function DecisionCard({ title, lines, prompt, pendingText, onDecide }: DecisionCardProps) {
  const ink = useWorklinePalette();
  const decided = useRef(false);
  const [pending, setPending] = useState(false);
  useInput((input, key) => {
    if (decided.current) return;
    const answer = decisionKey(input, key);
    if (answer === null) return;
    decided.current = true;
    setPending(true);
    onDecide(answer === 'yes');
  });
  return (
    <Box flexDirection="column" borderStyle="double" {...(ink.accent.color ? { borderColor: ink.accent.color } : {})} paddingX={1}>
      <Text {...ink.accent}>{title}</Text>
      {lines.map((line, index) => <Text key={index}>{line}</Text>)}
      <Text {...ink.muted}>{pending ? pendingText : prompt}</Text>
    </Box>
  );
}
