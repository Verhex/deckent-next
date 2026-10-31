import { describe, expect, it } from 'vitest';
import { PALETTE_THEMES, THEME_BACKGROUNDS, THEME_PALETTES, THEME_TEXT_MINIMUM, resolveTerminalTheme, resolveWorklinePalette, terminalPalette } from '#surfaces/core/terminal-kit/index.js';
import { colorCapability, colorTier } from '#platform/index.js';
import { parseTerminalColor } from '#surfaces/core/terminal-window/index.js';

// WCAG 2.2 (W3C Recommendation 12 Dec 2024) glossary: relative luminance (sRGB, 0.04045 threshold) and contrast ratio (L1 + 0.05) / (L2 + 0.05).
const channel = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string) => { const n = Number.parseInt(hex.slice(1), 16); return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05); };
// xterm 256-colour index → hex (cube 16–231, gray ramp 232–255), to measure the ansi256 tier too.
const CUBE = [0, 95, 135, 175, 215, 255];
const xterm = (index: number) => {
  const rgb = index >= 232 ? Array(3).fill(8 + 10 * (index - 232)) as number[] : [CUBE[Math.floor((index - 16) / 36)]!, CUBE[Math.floor((index - 16) / 6) % 6]!, CUBE[(index - 16) % 6]!];
  return `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`;
};

describe('terminal themes (T2 T-READABLE)', () => {
  it('model blue and provider purple both reach 4.5:1 in truecolor and ansi256 on dark/light reference backgrounds', () => {
    for (const theme of PALETTE_THEMES) for (const role of ['model', 'provider'] as const) {
      const entry = THEME_PALETTES[theme][role];
      // The 16-colour themes carry no hex: the terminal's own palette draws them (measured as a report, proof/ALPHA60/PAKET-2/THA).
      expect(entry.hex === null).toBe(THEME_BACKGROUNDS[theme].length === 0);
      for (const background of THEME_BACKGROUNDS[theme]) {
        expect(contrast(entry.hex!, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(xterm(entry.ansi256!), background)).toBeGreaterThanOrEqual(4.5);
      }
      expect(resolveWorklinePalette('none', theme)[role]).toEqual({});
    }
  });
  it('every truecolor text role reaches 4.5:1 (high contrast 7:1) and every border role 3:1 on each reference background, the owner\'s #F0ECE5 included', () => {
    const failures: string[] = [];
    expect(THEME_BACKGROUNDS.light).toContain('#F0ECE5'); expect(THEME_BACKGROUNDS['light-high-contrast']).toContain('#F0ECE5');
    expect([THEME_TEXT_MINIMUM['dark-high-contrast'], THEME_TEXT_MINIMUM['light-high-contrast'], THEME_TEXT_MINIMUM.light]).toEqual([7, 7, 4.5]);
    for (const theme of PALETTE_THEMES) for (const [role, entry] of Object.entries(THEME_PALETTES[theme])) {
      if (entry.hex === null) { expect(entry.contrast).toBe('none'); continue; }
      const minimum = entry.contrast === 'border' ? 3 : THEME_TEXT_MINIMUM[theme];
      for (const background of THEME_BACKGROUNDS[theme]) {
        const ratio = contrast(entry.hex, background);
        if (ratio < minimum) failures.push(`${theme}.${role} ${entry.hex} on ${background}: ${ratio.toFixed(2)} < ${minimum}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('the 256-colour approximations keep 4.5:1 for text roles and 3:1 for borders; light 16-colour sets use no yellow and no bright 9x on text', () => {
    const measured: string[] = [];
    for (const theme of PALETTE_THEMES) for (const [role, entry] of Object.entries(THEME_PALETTES[theme])) {
      if (entry.ansi256 === null) continue;
      const minimum = entry.contrast === 'border' ? 3 : 4.5;
      for (const background of THEME_BACKGROUNDS[theme]) if (contrast(xterm(entry.ansi256), background) < minimum) measured.push(`${theme}.${role} ${entry.ansi256} on ${background}`);
    }
    expect(measured).toEqual([]);
    // Codex style.rs: yellow disappears on light backgrounds; the bright 9x codes wash out there (One Half Light 94 = 2.26:1). Border roles keep 90 (≥5.7:1).
    const washed: string[] = [];
    for (const theme of ['light', 'light-daltonized', 'light-ansi', 'light-high-contrast', 'neutral-ansi'] as const) for (const [role, entry] of Object.entries(THEME_PALETTES[theme])) {
      const border = THEME_PALETTES.dark[role as keyof typeof THEME_PALETTES.dark].contrast === 'border';
      if (entry.ansi16 === '33' || (!border && /^9\d$/u.test(entry.ansi16))) washed.push(`${theme}.${role} ${entry.ansi16}`);
    }
    expect(washed).toEqual([]);
    // neutral-ansi (auto on an unknown background): colour only on status marks, which always carry a glyph and a word.
    expect(Object.entries(THEME_PALETTES['neutral-ansi']).filter(([, entry]) => entry.ansi16 !== '' && entry.ansi16 !== '90').map(([role]) => role).sort())
      .toEqual(['chipFail', 'chipOk', 'diffAdded', 'diffRemoved', 'stateConnected', 'workerCard']);
  });

  it('the daltonized themes keep success and error apart on the blue/orange axis, not red/green', () => {
    for (const theme of ['dark-daltonized', 'light-daltonized'] as const) {
      const palette = THEME_PALETTES[theme];
      expect(palette.success.ansi16).toMatch(/^(34|94)$/u);
      // Light 16 colours have no readable yellow/orange: error is red against blue success (still apart for red–green deficiencies).
      expect(palette.error.ansi16).toBe(theme === 'light-daltonized' ? '31' : '93');
      expect(palette.diffAdded.hex).toBe(palette.success.hex);
      expect(palette.diffRemoved.hex).toBe(palette.error.hex);
      expect(palette.success.hex).not.toBe(THEME_PALETTES.dark.success.hex);
    }
  });

  it('maps the T2 roles: the worker card no longer borrows the user role; the person\'s label keeps the terminal foreground', () => {
    const palette = resolveWorklinePalette('ansi16');
    expect(palette.workerCard.color).toBe('green');
    expect(palette.userBar.color).toBe('gray');
    expect(palette.userLabel).toEqual({ bold: true });
    expect(palette.assistantLabel).toEqual({ color: 'blueBright', bold: true });
    expect(palette.windowBorder.color).toBe('gray');
    expect(palette.selection.inverse).toBe(true);
    expect(palette.diffAdded.color).toBe('green');
    expect(palette.diffRemoved.color).toBe('red');
    // Owner 2026-10-18: full-auto has its own colour; full access keeps the warning tone.
    expect(palette.modeIndicator.color).toBe('cyanBright'); expect(palette.warning.color).toBe('yellow');
    expect(resolveWorklinePalette('truecolor', 'light').assistantLabel.color).toBe('#0B6A9E');
    expect(resolveWorklinePalette('ansi16', 'dark-daltonized').diffRemoved.color).toBe('yellowBright');
    for (const style of Object.values(resolveWorklinePalette('none', 'light'))) expect(style).toEqual({});
    // TEMA S6 A: connected dark green, not connected orange; the light 16-colour set has no orange, so the word and `!` carry it in bold.
    expect([resolveWorklinePalette('truecolor', 'light').stateConnected.color, resolveWorklinePalette('truecolor', 'light').stateDisconnected.color]).toEqual(['#16774A', '#A64B00']);
    expect(resolveWorklinePalette('ansi16', 'light').stateDisconnected).toEqual({ bold: true });
    // S8 b: on a reported background a role below its minimum keeps only its attributes (dark theme forced onto the owner's #F0ECE5).
    const guarded = resolveWorklinePalette('truecolor', 'dark', '#F0ECE5');
    expect([guarded.chipOk, guarded.link, guarded.model]).toEqual([{ bold: true }, { underline: true }, {}]);
    expect(resolveWorklinePalette('truecolor', 'light', '#F0ECE5')).toEqual(resolveWorklinePalette('truecolor', 'light'));
    // The 256 tier is an approximation held to 4.5:1 (the gate above), also in the 7:1 themes.
    expect(resolveWorklinePalette('ansi256', 'light-high-contrast', '#F0ECE5')).toEqual(resolveWorklinePalette('ansi256', 'light-high-contrast'));
  });

  it('maps the SW-1 legibility roles: bold keys, muted identities, chip states and a system summary that is not the assistant colour', () => {
    const palette = resolveWorklinePalette('ansi16');
    expect(palette.keyLabel).toEqual({ bold: true });
    expect(palette.mutedId.color).toBe('gray');
    expect(palette.sectionHeader).toEqual({ color: 'cyan', bold: true });
    expect([palette.chipOk, palette.chipWarn, palette.chipFail]).toEqual([{ color: 'green', bold: true }, { color: 'yellow', bold: true }, { color: 'red', bold: true }]);
    expect(palette.systemLabel).toEqual({ color: 'magenta', bold: true });
    expect(palette.systemLabel.color).not.toBe(palette.assistantLabel.color);
    expect(resolveWorklinePalette('ansi16', 'dark-daltonized').chipFail.color).toBe('yellowBright');
    expect(resolveWorklinePalette('truecolor', 'light').chipOk.color).toBe('#16774A');
  });

  it('auto follows the OSC 11 answer, then COLORFGBG, and an unknown background draws neutral-ansi; ansi is the background\'s 16-colour theme', () => {
    expect(resolveTerminalTheme('auto', 'truecolor')).toEqual({ theme: 'neutral-ansi', tier: 'ansi16', background: 'unknown' });
    expect(resolveTerminalTheme('auto', 'truecolor', '15;0')).toEqual({ theme: 'dark', tier: 'truecolor', background: 'dark' });
    expect(resolveTerminalTheme('auto', 'ansi256', '0;15')).toEqual({ theme: 'light', tier: 'ansi256', background: 'light' });
    expect(resolveTerminalTheme('auto', 'truecolor', 'default;default').theme).toBe('neutral-ansi');
    // The OSC 11 answer wins over COLORFGBG; Codex is_light (luma > 128): the owner's #F0ECE5 is light, #1E1E1E dark.
    expect(resolveTerminalTheme('auto', 'truecolor', '15;0', '#F0ECE5')).toEqual({ theme: 'light', tier: 'truecolor', background: 'light' });
    expect(resolveTerminalTheme('auto', 'truecolor', undefined, '#1E1E1E').theme).toBe('dark');
    expect(resolveTerminalTheme('auto', 'truecolor', undefined, null).theme).toBe('neutral-ansi');
    expect(resolveTerminalTheme('light', 'truecolor')).toEqual({ theme: 'light', tier: 'truecolor', background: 'unknown' });
    expect(resolveTerminalTheme('dark-daltonized', 'ansi256').tier).toBe('ansi256');
    expect(resolveTerminalTheme('light-high-contrast', 'truecolor').tier).toBe('truecolor');
    expect(resolveTerminalTheme('light-ansi', 'truecolor')).toEqual({ theme: 'light-ansi', tier: 'ansi16', background: 'unknown' });
    expect([resolveTerminalTheme('ansi', 'truecolor', '15;0').theme, resolveTerminalTheme('ansi', 'truecolor', undefined, '#FAFAFA').theme,
      resolveTerminalTheme('ansi', 'truecolor').theme]).toEqual(['dark-ansi', 'light-ansi', 'neutral-ansi']);
    expect(resolveTerminalTheme('ansi', 'truecolor', '15;0').tier).toBe('ansi16');
    expect(resolveTerminalTheme('light', 'none').tier).toBe('none');
    expect(resolveTerminalTheme('auto', 'none', '15;0', '#F0ECE5').tier).toBe('none');
    // OSC 10/11 answers: 1–4 hex digits per channel scale to 8 bits (XParseColor); anything else is no answer.
    expect(['rgb:f0f0/ecec/e5e5', 'rgb:f0/ec/e5', 'rgb:f/e/e', 'RGBA:F0F0/ECEC/E5E5/FFFF', 'rgb:1e1e/1e1e/1e1e'].map(parseTerminalColor)).toEqual(['#F0ECE5', '#F0ECE5', '#FFEEEE', '#F0ECE5', '#1E1E1E']);
    expect(['', 'rgb:', 'rgb:12345/0/0', 'rgb:zz/00/00', '#ffffff', 'cmyk:0/0/0/0'].map(parseTerminalColor)).toEqual(Array(6).fill(null));
    expect(terminalPalette('auto', 'truecolor', undefined, '#F0ECE5').assistantLabel).toEqual({ color: '#0B6A9E', bold: true });
    expect(terminalPalette('auto', 'truecolor').assistantLabel).toEqual({ bold: true });
  });

  it('capability reads COLORTERM and TERM without the background guard; colorTier keeps the guard', () => {
    const tty = { isTTY: true, argv: [] as string[] };
    expect(colorCapability({ ...tty, env: { COLORTERM: 'truecolor' } })).toBe('truecolor');
    expect(colorCapability({ ...tty, env: { COLORTERM: '24bit' } })).toBe('truecolor');
    expect(colorCapability({ ...tty, env: { TERM: 'xterm-256color' } })).toBe('ansi256');
    expect(colorCapability({ ...tty, env: { TERM: 'xterm' } })).toBe('ansi16');
    expect(colorCapability({ ...tty, env: { COLORTERM: 'truecolor', NO_COLOR: '1' } })).toBe('none');
    expect(colorCapability({ ...tty, env: { COLORTERM: 'truecolor', TERM: 'dumb' } })).toBe('none');
    expect(colorCapability({ isTTY: false, argv: [], env: { COLORTERM: 'truecolor' } })).toBe('none');
    expect(colorCapability({ isTTY: true, argv: ['--no-color'], env: { COLORTERM: 'truecolor' } })).toBe('none');
    expect(colorTier({ ...tty, env: { COLORTERM: 'truecolor' } })).toBe('ansi16');
    expect(colorTier({ ...tty, env: { COLORTERM: 'truecolor', COLORFGBG: '15;0' } })).toBe('truecolor');
    expect(colorTier({ ...tty, env: { FORCE_COLOR: '3' } })).toBe('truecolor');
  });
});
