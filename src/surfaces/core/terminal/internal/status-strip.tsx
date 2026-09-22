import { Box, Text } from 'ink';
import { useWorklinePalette } from './ink-palette-context.js';

export interface StatusStripProps {
  readonly profileId: string;
  readonly endpoint: string | null;
  readonly busy: boolean;
  readonly readyLabel: string;
  readonly busyLabel: string;
}

export function StatusStrip({ profileId, endpoint, busy, readyLabel, busyLabel }: StatusStripProps) {
  const palette = useWorklinePalette();
  return (
    <Box flexDirection="row" gap={2}>
      <Text {...palette.accent}>{profileId}</Text>
      <Text {...palette.muted}>{endpoint ?? '—'}</Text>
      <Text {...(busy ? palette.user : palette.muted)}>{busy ? busyLabel : readyLabel}</Text>
    </Box>
  );
}
