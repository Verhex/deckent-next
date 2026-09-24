import { Box, Text } from 'ink';
import type { InkRoleStyle, WorklineInkPalette } from '#surfaces/core/terminal-kit/index.js';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import type { RenderedLine, Span } from './spans.js';

/** Maps the pure span model onto the active palette; the `none` tier resolves every role and attribute to nothing. */
export function spanStyle(part: Span, palette: WorklineInkPalette): InkRoleStyle {
  return { ...(part.role ? palette[part.role] : {}), ...(part.bold ? palette.strong : {}), ...(part.italic ? palette.emphasis : {}), ...(part.strike ? palette.strike : {}) };
}

export function SpanText({ spans }: { readonly spans: readonly Span[] }) {
  const palette = useWorklinePalette();
  return <>{spans.map((part, index) => <Text key={index} {...spanStyle(part, palette)}>{part.text}</Text>)}</>;
}

/**
 * One Ink row per rendered line: the prefix (bullet, rail, quote bar) stays fixed and the body wraps under it with a
 * hanging indent. Pre-fitted lines (code, tables, rules) truncate instead of wrapping so a frame never breaks.
 */
export function RenderedLines({ lines }: { readonly lines: readonly RenderedLine[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((entry, index) => (
        <Box key={index} flexDirection="row">
          {entry.prefix.length > 0 && <Box flexShrink={0}><Text><SpanText spans={entry.prefix} /></Text></Box>}
          <Box flexShrink={1} flexGrow={1}>
            <Text wrap={entry.wrap ? 'wrap' : 'truncate-end'}>{entry.body.length > 0 ? <SpanText spans={entry.body} /> : ' '}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
