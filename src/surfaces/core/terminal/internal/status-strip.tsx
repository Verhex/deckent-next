import { Box, Text } from 'ink';
import { useWorklinePalette } from './ink-palette-context.js';

export interface StatusStripProps {
  readonly target: string;
  readonly state: string;
  readonly busy: boolean;
}

export function StatusStrip({ target, state, busy }: StatusStripProps) {
  const palette = useWorklinePalette();
  return (
    <Box flexDirection="row" gap={2}>
      <Text {...palette.accent}>{target}</Text>
      <Text {...(busy ? palette.user : palette.muted)}>{state}</Text>
    </Box>
  );
}
