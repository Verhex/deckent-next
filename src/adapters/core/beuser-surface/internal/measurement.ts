/** The xterm buffer-cell reads this measurement uses (structural, so published declarations do not name @xterm/headless). */
interface MeasuredCell { getFgColor(): number; getBgColor(): number; isFgRGB(): boolean; isBgRGB(): boolean; isFgPalette(): boolean; isBgPalette(): boolean;
  isInverse(): number; isDim(): number; isInvisible(): number; isBold(): number; getChars(): string; getWidth(): number }
import { z } from 'zod';
import { BeuserSurfaceError } from './input.js';

// WCAG 2.2 contrast formula invariant, not mutable policy.
const WCAG_OFFSET = 0.05;
const hex = z.string().regex(/^#[\da-f]{6}$/iu);
export const beuserTerminalFixtureSchema = z.object({ foreground: hex, background: hex,
  ansi: z.array(hex).length(16), osc11: z.object({ reply: z.boolean(), delayMs: z.number().int().min(0).safe(), digits: z.number().int().min(1).max(4) }).strict(),
  colorTier: z.enum(['truecolor', 'none']), colorfgbg: z.string().regex(/^\d+;\d+$/u).optional() }).strict();
export type BeuserTerminalFixture = z.infer<typeof beuserTerminalFixtureSchema>;
export interface CellRun { x: number; y: number; text: string; width: number; foreground: string; background: string;
  contrast: number | null; dim: boolean; invisible: boolean; bold: boolean; inverse: boolean }

/** Fixture configuration is sealed rubric data, never persona input or executable authority. */
export function beuserTerminalFixture(parameters: Readonly<Record<string, unknown>>, states: readonly string[]): BeuserTerminalFixture | undefined {
  if (parameters['terminalFixtures'] === undefined) return undefined;
  const rows = z.array(z.object({ state: z.string(), settings: beuserTerminalFixtureSchema }).strict()).safeParse(parameters['terminalFixtures']);
  if (!rows.success) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
  const selected = rows.data.filter(row => states.includes(row.state));
  if (selected.length !== 1) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
  return selected[0]!.settings;
}
const rgb = (color: string) => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
const luminance = (color: string) => rgb(color).map(value => { const n = value / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; })
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
const contrast = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + WCAG_OFFSET) / (Math.min(x, y) + WCAG_OFFSET); };
function palette(index: number, fixture: BeuserTerminalFixture): string {
  if (index < 16) return fixture.ansi[index]!;
  const cube = [0, 95, 135, 175, 215, 255], n = index - 16;
  const values = index >= 232 ? Array<number>(3).fill(8 + (index - 232) * 10)
    : [cube[Math.floor(n / 36)]!, cube[Math.floor(n / 6) % 6]!, cube[n % 6]!];
  return '#' + values.map(value => value.toString(16).padStart(2, '0')).join('');
}
export function measureCell(cell: MeasuredCell, fixture: BeuserTerminalFixture, x: number, y: number): CellRun {
  const color = (foreground: boolean) => {
    const value = foreground ? cell.getFgColor() : cell.getBgColor();
    return (foreground ? cell.isFgRGB() : cell.isBgRGB()) ? '#' + value.toString(16).padStart(6, '0')
      : (foreground ? cell.isFgPalette() : cell.isBgPalette()) ? palette(value, fixture) : foreground ? fixture.foreground : fixture.background;
  };
  let foreground = color(true), background = color(false);
  const inverse = !!cell.isInverse(), dim = !!cell.isDim(), invisible = !!cell.isInvisible();
  if (inverse) [foreground, background] = [background, foreground];
  return { x, y, text: cell.getChars() || ' ', width: cell.getWidth(), foreground, background,
    // Terminal-specific dim compositing and hidden glyphs cannot be promoted to measured contrast.
    contrast: dim || invisible || !!cell.isBold() && !!cell.isFgPalette() && cell.getFgColor() < 8 ? null : contrast(foreground, background), dim, invisible, bold: !!cell.isBold(), inverse };
}
