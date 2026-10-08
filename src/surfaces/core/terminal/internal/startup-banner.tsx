import { createElement } from 'react';
import { Box, Text, renderToString } from 'ink';
import { useWorklinePalette, WorklinePaletteProvider, type WorklineInkPalette } from '#surfaces/core/terminal-kit/index.js';

/**
 * T2 T-STARTUP (owner 2026-10-07): when the rich surface opens, the visible screen is cleared and the cursor homed, so Deckent starts at the
 * top with its banner; earlier output moves into scrollback and is never erased. Every text is catalog text the caller resolved (the mark
 * already chosen as Unicode or ASCII); this unit translates nothing.
 */
/** `terminal.banner` values; the first is the default (the registry's `TERMINAL_BANNERS`, tested equal). */
export const STARTUP_BANNERS = ['full', 'compact', 'off'] as const;
export interface WorklineStartup {
  /** Clear the visible screen first (the caller already excluded TERM=dumb and the setting; this side still requires a TTY). */
  readonly clear: boolean;
  readonly banner: typeof STARTUP_BANNERS[number];
  /** The Deckent mark, one string per row (3–5 rows). */
  readonly logo: readonly string[];
  /** Beside the mark: the title row, then the static facts (project and model) and the hint. Current mode lives in the status strip. */
  readonly lines: readonly string[];
  /** The one-line form: narrow terminals and `banner: compact`. */
  readonly compact: string;
}

/** CUP home + ED 2 (erase the visible display). The opening frame never sends ED 3 (the person's shell history above Deckent stays). */
export const CLEAR_VISIBLE_SCREEN = '\u001b[H\u001b[2J';
/**
 * `/clear` (owner 2026-10-08, reverses SW-3 D2): home + ED 2 + ED 3 — the visible screen AND the terminal's own scrollback, so the earlier
 * conversation cannot be scrolled back to. ED 3 follows ED 2 because some terminals (VTE) push the erased screen into the scrollback first.
 */
export const CLEAR_SCREEN_AND_SCROLLBACK = '\u001b[H\u001b[2J\u001b[3J';
/**
 * The clear of the opening frame: `rows` line feeds first scroll every visible row into the scrollback from wherever the cursor is (xterm's
 * ED 2 erases the visible rows without keeping them; some terminals keep them), then home + ED 2 leaves an empty screen with the cursor at the top.
 */
export function clearVisibleScreen(rows: number): string {
  return `${'\n'.repeat(Math.max(1, Math.floor(rows)))}${CLEAR_VISIBLE_SCREEN}`;
}
/** Below this width the mark and its facts do not fit side by side: the one-line form is shown. */
export const STARTUP_BANNER_MIN_COLUMNS = 60;

export function StartupBanner({ startup, columns }: { readonly startup: WorklineStartup; readonly columns: number }) {
  const palette = useWorklinePalette();
  if (startup.banner === 'compact' || columns < STARTUP_BANNER_MIN_COLUMNS) return <Text {...palette.accent} wrap="truncate-end">{startup.compact}</Text>;
  const [title, ...facts] = startup.lines;
  const hint = facts.at(-1), details = facts.slice(0, -1);
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" marginRight={2}>{startup.logo.map((row, index) => <Text key={index} {...palette.accent}>{row}</Text>)}</Box>
      <Box flexDirection="column">
        {title ? <Text {...palette.strong} wrap="truncate-end">{title}</Text> : null}
        {details.map((line, index) => <Text key={index} wrap="truncate-end">{line}</Text>)}
        {hint ? <Text {...palette.muted} wrap="truncate-end">{hint}</Text> : null}
      </Box>
    </Box>
  );
}

/** The opening frame, printed once before the live view starts (it goes into the main-screen scrollback like any finished output). */
export function startupFrame(startup: WorklineStartup, palette: WorklineInkPalette, columns: number, rows: number): string {
  const clear = startup.clear ? clearVisibleScreen(rows) : '';
  if (startup.banner === 'off') return clear;
  const banner = renderToString(createElement(WorklinePaletteProvider, { palette, children: createElement(StartupBanner, { startup, columns }) }), { columns });
  return `${clear}${banner}\n`;
}

/** Writes the opening frame on an interactive terminal only: a pipe or redirect never receives a clear sequence or the banner. */
export function writeStartup(stdout: Pick<NodeJS.WriteStream, 'write' | 'isTTY' | 'columns' | 'rows'>, startup: WorklineStartup, palette: WorklineInkPalette): void {
  if (stdout.isTTY !== true) return;
  const frame = startupFrame(startup, palette, stdout.columns || 80, stdout.rows || 24);
  if (frame) stdout.write(frame);
}
