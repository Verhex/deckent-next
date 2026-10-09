import { useEffect, useState } from 'react';
import { Text, useAnimation, useWindowSize } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { useRenderGlyphs, useHumanTextSecrets, projectHumanPickerText } from '#surfaces/core/terminal-render/index.js';
import { spanStyle } from '#surfaces/core/terminal-render/index.js';
import { fitStatusRow, worklineStatusSegments, type StatusSegment, type WorklineStatusLabels } from '#surfaces/core/terminal-render/index.js';
import type { PermissionMode } from '#domain/index.js';
import type { PermissionModeStop } from '#surfaces/core/terminal-render/index.js';

export interface StatusStripProps {
  /** Scope (or the pre-joined `scope · model` target); shrinks from the start before anything wraps. */
  readonly target: string;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly state: string;
  readonly busy: boolean;
  readonly queued?: number | undefined;
  /** Short service notice (for example a build skew), the first fact dropped on a narrow terminal. */
  readonly notice?: string | undefined;
  readonly labels: WorklineStatusLabels;
  /** The person's permission mode (catalog text, droppable); absent when unknown. */
  readonly mode?: PermissionMode | undefined;
  /** T2: the session's cycle stop (`ask-edits` is standart with the preference); the row shows its mark and word. */
  readonly stop?: PermissionModeStop | undefined;
  readonly selfSource?: boolean | undefined;
  /** A chat turn runs and Esc cancels it now (TL-A D5). */
  readonly cancellable?: boolean | undefined;
  /** SLASH-WINDOWS: the reasoning state in the catalog's words (`/reasoning` window); droppable before the mode. */
  readonly reasoning?: string | undefined;
}

/** One inline text node measured against live terminal width; no wrapping or stale lines on resize (legacy f18d53fb8, row 7143). */
export function StatusStrip({ target, model, provider, state, busy, queued, notice, labels, mode, stop, selfSource, cancellable, reasoning }: StatusStripProps) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const known = useHumanTextSecrets(), identity = model ? provider ? `${model} (${provider})` : model : '';
  // Mask the complete identity before splitting or dropping it; a known secret can span both names.
  const projected = projectHumanPickerText(identity, known).label;
  const unchanged = projected === identity;
  const { columns } = useWindowSize();
  const { frame } = useAnimation({ interval: 120, isActive: busy });
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => { setSince(busy ? Date.now() : null); }, [busy]);
  const segments = worklineStatusSegments({ scope: target, model: unchanged ? model : projected, provider: unchanged ? provider : undefined, state, busy, spinner: glyphs.spinner[frame % glyphs.spinner.length],
    elapsedMs: since === null ? undefined : Date.now() - since, queued, notice, labels, mode, selfSource, cancellable, stop, modeMark: stop ? glyphs.mode[stop] : undefined });
  const separator = ` ${glyphs.separator} `;
  const reasoningSegment: StatusSegment | null = reasoning ? Object.freeze({ id: 'reasoning', text: reasoning, role: 'muted' as const, priority: 48, droppable: true, shrink: false }) : null;
  const modeAt = segments.findIndex(segment => segment.id === 'mode');
  const shown = reasoningSegment ? [...segments.slice(0, modeAt + 1 || segments.length), reasoningSegment, ...segments.slice(modeAt + 1 || segments.length)] : segments;
  const layout = fitStatusRow(shown, columns || 80, separator, glyphs.ellipsis);
  return (
    <Text wrap="truncate-end">
      {layout.segments.map((segment, index) => (
        <Text key={segment.id}>{index > 0 ? segment.id === 'provider' ? ' ' : separator : ''}<Text {...(segment.role ? spanStyle({ text: '', role: segment.role, ...(segment.bold ? { bold: true } : {}) }, palette) : {})}>{segment.text}</Text></Text>
      ))}
    </Text>
  );
}
