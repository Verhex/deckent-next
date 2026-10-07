import type { PaletteTheme } from './generated/palette.js';
import type { ColorTier } from './ink-palette.js';

/** `terminal.theme` (T2 T-READABLE): `auto` follows the background when the terminal reports it, `ansi` keeps the terminal's own 16 colours. */
export const TERMINAL_THEME_SETTINGS = ['auto', 'dark', 'light', 'dark-daltonized', 'light-daltonized', 'ansi'] as const;
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

/**
 * The theme and colour tier the workline draws with. `capability` is what the terminal can draw (`colorCapability`); none stays none. An
 * explicit theme uses the full capability. `auto` uses the dark or light theme when the background is reported, and otherwise stays in
 * ansi16 so the terminal's own palette (which knows its background) decides; `ansi` always stays in ansi16.
 */
export function resolveTerminalTheme(setting: TerminalThemeSetting, capability: ColorTier, colorfgbg?: string): TerminalThemeChoice {
  const background = terminalBackground(colorfgbg);
  const ansi16 = (theme: PaletteTheme): TerminalThemeChoice => ({ theme, tier: capability === 'none' ? 'none' : 'ansi16', background });
  if (setting === 'ansi') return ansi16('dark');
  if (setting !== 'auto') return { theme: setting, tier: capability, background };
  return background === 'unknown' ? ansi16('dark') : { theme: background, tier: capability, background };
}
