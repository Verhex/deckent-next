import { Box, Text } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { useRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { modelProviderSpans, spanStyle, type ModelProviderLabel } from '#surfaces/core/terminal-render/index.js';

/**
 * The scrollback entry id of a system summary line (a `notice` entry with this id). SW-2's placeholder `systemSummaryLine(text)` uses the
 * same id, so the ledger row can render every such entry through `SystemSummaryLine`.
 */
export const SYSTEM_SUMMARY_ENTRY_ID = 'system-summary';

/** One line: whitespace and line breaks fold to single spaces (a summary is never a multi-line blob). */
export function systemSummaryText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * The ONE framed, labelled line a slash window leaves in the scrollback when it closes (owner 2026-10-08, directive 1). It never looks like
 * the assistant's answer: its own rail (`systemRail`), its own mark and label (`◆ Deckent system`, `systemLabel`), and the text in the
 * terminal's foreground. The label word and the mark carry the meaning without colour (NO_COLOR, TERM=dumb).
 */
export function SystemSummaryLine({ text, identity, label, tone = 'info' }: { readonly text: string; readonly identity?: ModelProviderLabel | undefined; readonly label: string; readonly tone?: 'info' | 'warning' | 'error' }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const mark = glyphs.ascii ? '#' : '◆';
  return (
    <Box borderStyle={glyphs.ascii ? 'classic' : 'bold'} borderTop={false} borderRight={false} borderBottom={false}
      {...(palette.systemRail.color ? { borderLeftColor: palette.systemRail.color } : {})} paddingLeft={1}>
      <Text wrap="wrap">
        <Text {...palette.systemLabel}>{`${mark} ${label}`}</Text>
        <Text {...palette.muted}>{` ${glyphs.separator} `}</Text>
        <Text {...(tone === 'error' ? palette.error : tone === 'warning' ? palette.warning : {})}>{modelProviderSpans(systemSummaryText(text), identity)
          .map((part, index) => <Text key={index} {...spanStyle(part, palette)}>{part.text}</Text>)}</Text>
      </Text>
    </Box>
  );
}
