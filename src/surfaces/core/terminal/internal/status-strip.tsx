import { useEffect, useState } from 'react';
import { Text, useAnimation, useWindowSize } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { useRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { spanStyle } from '#surfaces/core/terminal-render/index.js';
import { fitStatusRow, worklineStatusSegments, type WorklineStatusLabels } from '#surfaces/core/terminal-render/index.js';

export interface StatusStripProps {
  /** Scope (or the pre-joined `scope · model` target); shrinks from the start before anything wraps. */
  readonly target: string;
  readonly model?: string | undefined;
  readonly state: string;
  readonly busy: boolean;
  readonly queued?: number | undefined;
  /** Short service notice (for example a build skew), the first fact dropped on a narrow terminal. */
  readonly notice?: string | undefined;
  readonly labels: WorklineStatusLabels;
}

/**
 * One inline text node measured against the live terminal width (Ink `useWindowSize` re-renders on resize), so the row
 * never wraps and never leaves stale lines behind when the terminal narrows (legacy f18d53fb8, row 7143).
 */
export function StatusStrip({ target, model, state, busy, queued, notice, labels }: StatusStripProps) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const { columns } = useWindowSize();
  const { frame } = useAnimation({ interval: 120, isActive: busy });
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => { setSince(busy ? Date.now() : null); }, [busy]);
  const segments = worklineStatusSegments({ scope: target, model, state, busy, spinner: glyphs.spinner[frame % glyphs.spinner.length],
    elapsedMs: since === null ? undefined : Date.now() - since, queued, notice, labels });
  const separator = ` ${glyphs.separator} `;
  const layout = fitStatusRow(segments, columns || 80, separator, glyphs.ellipsis);
  return (
    <Text wrap="truncate-end">
      {layout.segments.map((segment, index) => (
        <Text key={segment.id}>{index > 0 ? separator : ''}<Text {...(segment.role ? spanStyle({ text: '', role: segment.role }, palette) : {})}>{segment.text}</Text></Text>
      ))}
    </Text>
  );
}
