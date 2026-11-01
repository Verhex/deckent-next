import { THEME_BACKGROUNDS, type PaletteTheme } from './generated/palette.js';
import { resolveWorklinePalette, type ColorTier, type WorklineInkPalette } from './ink-palette.js';

/** `terminal.theme` (TEMA-OKUNURLUK, owner S2 A 2026-10-30): the Claude Code theme set plus two high-contrast themes; `auto` follows the
 * background the terminal reports. `ansi` is the earlier value, kept as an alias: the 16-colour theme of the reported background. */
export const TERMINAL_THEME_SETTINGS = ['auto', 'dark', 'light', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi', 'dark-high-contrast',
  'light-high-contrast', 'ansi'] as const;
export type TerminalThemeSetting = typeof TERMINAL_THEME_SETTINGS[number];
export type TerminalBackground = 'dark' | 'light' | 'unknown';
export interface TerminalThemeChoice { readonly theme: PaletteTheme; readonly tier: ColorTier; readonly background: TerminalBackground }

/** `COLORFGBG` (rxvt/Konsole/iTerm convention `fg;bg`): background index 0–6 or 8 is dark, 7 or 9–15 light; anything else is unknown. */
export function terminalBackground(colorfgbg: string | undefined): TerminalBackground {
  const value = colorfgbg?.split(';').at(-1)?.trim() ?? '';
  if (!/^\d{1,2}$/u.test(value)) return 'unknown';
  const index = Number(value);
  if (index === 8 || index <= 6) return 'dark';
  return index <= 15 ? 'light' : 'unknown';
}

/** Codex `is_light`: a colour is light when its luma 0.299R + 0.587G + 0.114B is above 128. */
function lightness(hex: string): TerminalBackground {
  const value = Number.parseInt(hex.slice(1), 16);
  return 0.299 * (value >> 16) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255) > 128 ? 'light' : 'dark';
}

/**
 * The theme and colour tier the terminal draws with. `capability` is what the terminal can draw (`colorCapability`); none stays none. The
 * background is the OSC 11 answer (`reported`, `#RRGGBB`), else `COLORFGBG`, else unknown. An explicit theme uses the full capability; the 16-colour themes (no
 * reference backgrounds: nothing to measure) stay in ansi16. `auto` uses the dark or light theme of the background, and `neutral-ansi`
 * (the terminal's own foreground with attributes, colour only on status marks) when it is unknown; `ansi` picks the 16-colour theme the same way.
 */
export function resolveTerminalTheme(setting: TerminalThemeSetting, capability: ColorTier, colorfgbg?: string, reported?: string | null): TerminalThemeChoice {
  const background = reported ? lightness(reported) : terminalBackground(colorfgbg);
  const theme: PaletteTheme = setting === 'auto' ? (background === 'unknown' ? 'neutral-ansi' : background)
    : setting === 'ansi' ? (background === 'unknown' ? 'neutral-ansi' : `${background}-ansi`) : setting;
  const ansiOnly = THEME_BACKGROUNDS[theme].length === 0;
  return { theme, tier: capability === 'none' || !ansiOnly ? capability : 'ansi16', background };
}

/** The one theme answer every terminal screen uses: the setting against what the terminal reported, drawn at `capability`; a reported OSC 11
 * colour also guards each role's contrast (`resolveWorklinePalette`). */
export function terminalPalette(setting: TerminalThemeSetting, capability: ColorTier, colorfgbg?: string, reported?: string | null): WorklineInkPalette {
  const choice = resolveTerminalTheme(setting, capability, colorfgbg, reported);
  return resolveWorklinePalette(choice.tier, choice.theme, reported ?? undefined);
}
