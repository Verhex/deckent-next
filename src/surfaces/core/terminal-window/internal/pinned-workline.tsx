import { useRef, useState, type ReactNode } from 'react';
import { Box, Text, useBoxMetrics, useStdout, useWindowSize, type DOMElement } from 'ink';
import { WindowStackProvider, useFocusOwner } from './window-stack.js';

/**
 * Bounded main-screen live area (TERMINAL-SABIT R3): the live part (windows, live answer) and the footer (status, composer, hint) are at
 * most `rows - 1` tall — one row stays for Ink's trailing newline, so Ink never takes its full-screen (ED3) overflow path. The live part
 * shrinks and clips its top; the footer never shrinks. Completed records stay in Ink `Static` above, so they are on screen once and in the
 * native scrollback once; the composer sits under the content and, once the screen is full, on the bottom rows (the Claude Code model).
 * The tree shape is the same in both modes, so a size change never remounts the composer or a window.
 */
export function PinnedWorkline({ children, footer, enabled = true }: { readonly children: ReactNode; readonly footer: ReactNode; readonly enabled?: boolean }) {
  const { stdout } = useStdout(), size = useWindowSize();
  const footerRef = useRef<DOMElement | null>(null), metrics = useBoxMetrics(footerRef);
  const [mode] = useState(() => enabled && stdout.isTTY === true);
  const bounded = mode && size.rows > 0 && size.columns > 0;
  const maxHeight = Math.max(1, size.rows - 1), footerHeight = Math.min(maxHeight, metrics.height || 8);
  return <WindowStackProvider composerDefault={mode} reservedRows={bounded ? footerHeight + 1 : undefined}>
    <Box flexDirection="column" {...(bounded ? { maxHeight, width: size.columns, overflow: 'hidden' as const } : {})}>
      <Box flexDirection="column" flexShrink={1} justifyContent="flex-end" overflow={bounded ? 'hidden' : 'visible'}>
        <Box flexDirection="column" flexShrink={0}>{children}</Box>
      </Box>
      <Box ref={footerRef} flexDirection="column" flexShrink={0}>{footer}</Box>
    </Box>
  </WindowStackProvider>;
}

/** Focus is described in catalog words, without using colour as the only carrier. */
export function WindowFocusHint({ composer, window, fallback }: { readonly composer?: string | undefined; readonly window?: string | undefined; readonly fallback: string }) {
  const owner = useFocusOwner();
  return <Text wrap="truncate-end">{owner.top ? (owner.composing ? composer : window) ?? fallback : fallback}</Text>;
}
