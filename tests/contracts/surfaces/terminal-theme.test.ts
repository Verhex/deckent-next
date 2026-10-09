import { describe, expect, it } from 'vitest';
import { PALETTE_THEMES, THEME_BACKGROUNDS, THEME_PALETTES, resolveTerminalTheme, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { colorCapability, colorTier } from '#platform/index.js';

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
      for (const background of THEME_BACKGROUNDS[theme]) {
        expect(contrast(entry.hex!, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(xterm(entry.ansi256!), background)).toBeGreaterThanOrEqual(4.5);
      }
      expect(resolveWorklinePalette('none', theme)[role]).toEqual({});
    }
  });
  it('every truecolor text role reaches 4.5:1 and every border role 3:1 on each reference background of its theme', () => {
    const failures: string[] = [];
    for (const theme of PALETTE_THEMES) for (const [role, entry] of Object.entries(THEME_PALETTES[theme])) {
      if (entry.hex === null) { expect(entry.contrast).toBe('none'); continue; }
      const minimum = entry.contrast === 'border' ? 3 : 4.5;
      for (const background of THEME_BACKGROUNDS[theme]) {
        const ratio = contrast(entry.hex, background);
        if (ratio < minimum) failures.push(`${theme}.${role} ${entry.hex} on ${background}: ${ratio.toFixed(2)} < ${minimum}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('the 256-colour approximations of the text roles keep at least 3:1 (measured, the 256 tier is an approximation)', () => {
    const measured: string[] = [];
    for (const theme of PALETTE_THEMES) for (const [role, entry] of Object.entries(THEME_PALETTES[theme])) {
      if (entry.ansi256 === null) continue;
      for (const background of THEME_BACKGROUNDS[theme]) if (contrast(xterm(entry.ansi256), background) < 3) measured.push(`${theme}.${role} ${entry.ansi256} on ${background}`);
    }
    expect(measured).toEqual([]);
  });

  it('the daltonized themes keep success and error apart on the blue/orange axis, not red/green', () => {
    for (const theme of ['dark-daltonized', 'light-daltonized'] as const) {
      const palette = THEME_PALETTES[theme];
      expect(palette.success.ansi16).toMatch(/^(34|94)$/u);
      expect(palette.error.ansi16).toMatch(/^(33|93)$/u);
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
    expect(palette.modeIndicator.color).toBe('yellow');
    expect(resolveWorklinePalette('truecolor', 'light').assistantLabel.color).toBe('#0B6A9E');
    expect(resolveWorklinePalette('ansi16', 'dark-daltonized').diffRemoved.color).toBe('yellowBright');
    for (const style of Object.values(resolveWorklinePalette('none', 'light'))) expect(style).toEqual({});
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

  it('auto follows a reported background and otherwise stays in the terminal\'s own 16 colours', () => {
    expect(resolveTerminalTheme('auto', 'truecolor')).toEqual({ theme: 'dark', tier: 'ansi16', background: 'unknown' });
    expect(resolveTerminalTheme('auto', 'truecolor', '15;0')).toEqual({ theme: 'dark', tier: 'truecolor', background: 'dark' });
    expect(resolveTerminalTheme('auto', 'ansi256', '0;15')).toEqual({ theme: 'light', tier: 'ansi256', background: 'light' });
    expect(resolveTerminalTheme('auto', 'truecolor', 'default;default').tier).toBe('ansi16');
    expect(resolveTerminalTheme('light', 'truecolor')).toEqual({ theme: 'light', tier: 'truecolor', background: 'unknown' });
    expect(resolveTerminalTheme('dark-daltonized', 'ansi256').tier).toBe('ansi256');
    expect(resolveTerminalTheme('ansi', 'truecolor', '15;0').tier).toBe('ansi16');
    expect(resolveTerminalTheme('light', 'none').tier).toBe('none');
    expect(resolveTerminalTheme('auto', 'none', '15;0').tier).toBe('none');
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
