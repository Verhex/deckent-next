import { useRef, type ReactNode } from 'react';
import { Box, Text, useBoxMetrics, useStdout, useWindowSize, type DOMElement } from 'ink';
import { WindowStackProvider, useFocusOwner } from './window-stack.js';

/** Main-screen live area: leave Ink's trailing newline one row, keeping its ED3 overflow path out of normal redraws. */
export function PinnedWorkline({ history, children, footer, enabled = true }: { readonly history: ReactNode; readonly children: ReactNode; readonly footer: ReactNode; readonly enabled?: boolean }) {
  const { stdout } = useStdout(), size = useWindowSize();
  const footerRef = useRef<DOMElement | null>(null), metrics = useBoxMetrics(footerRef);
  const pinned = enabled && stdout.isTTY === true && size.rows > 0 && size.columns > 0;
  const height = Math.max(1, size.rows - 1), footerHeight = Math.min(height, metrics.height || 8);
  return <WindowStackProvider composerDefault={pinned} reservedRows={pinned ? footerHeight + 1 : undefined}>
    {pinned ? <Box flexDirection="column" height={height} width={size.columns} overflow="hidden">
      <Box flexDirection="column" height={Math.max(0, height - footerHeight)} flexShrink={0} overflow="hidden" justifyContent="flex-end">
        <Box flexDirection="column" flexShrink={0}>{history}{children}</Box>
      </Box>
      <Box height={footerHeight} flexDirection="column" flexShrink={0} overflow="hidden" justifyContent="flex-end">
        <Box ref={footerRef} flexDirection="column" flexShrink={0}>{footer}</Box>
      </Box>
    </Box> : <Box flexDirection="column">{children}<Box ref={footerRef} flexDirection="column">{footer}</Box></Box>}
  </WindowStackProvider>;
}

/** Focus is described in catalog words, without using colour as the only carrier. */
export function WindowFocusHint({ composer, window, fallback }: { readonly composer?: string | undefined; readonly window?: string | undefined; readonly fallback: string }) {
  const owner = useFocusOwner();
  return <Text wrap="truncate-end">{owner.top ? (owner.composing ? composer : window) ?? fallback : fallback}</Text>;
}
