export type ColorTier = 'none' | 'ansi16' | 'ansi256' | 'truecolor';
import { THEME_PALETTES, THEME_TEXT_MINIMUM, type PaletteRole, type PaletteTheme } from './generated/palette.js';

/** Workline layout roles projected from semantic palette roles, plus the rendered-answer roles (markdown, status). T2 (T-READABLE): the person's
 * line (`userBar` rail, `userLabel`), the answer heading (`assistantLabel`), worker cards, windows, selection, diff marks and the mode indicator.
 * SW-1 (2026-10-08): information windows (`sectionHeader`, bold `keyLabel`, `mutedId`, the `chipOk`/`chipWarn`/`chipFail` states) and the
 * system summary line (`systemLabel`, `systemRail`), which must never look like the assistant's answer. TEMA S6 A (2026-10-30): connection
 * states (`stateConnected` dark green, `stateDisconnected` orange), always with a glyph and a word. */
export type WorklineInkRole = 'model' | 'provider' | 'accent' | 'muted' | 'user' | 'assistant' | 'error' | 'code' | 'link' | 'info' | 'success' | 'warning'
  | 'userBar' | 'userLabel' | 'assistantLabel' | 'workerCard' | 'windowBorder' | 'windowTitle' | 'focus' | 'selection' | 'diffAdded' | 'diffRemoved'
  | 'modeIndicator' | 'sectionHeader' | 'keyLabel' | 'mutedId' | 'chipOk' | 'chipWarn' | 'chipFail' | 'systemLabel' | 'systemRail'
  | 'stateConnected' | 'stateDisconnected' | 'strong' | 'emphasis' | 'strike';

export type InkRoleStyle = Readonly<{ color?: string; bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean; inverse?: boolean; dimColor?: boolean }>;

export type WorklineInkPalette = Readonly<Record<WorklineInkRole, InkRoleStyle>>;

const ANSI16_NAME: Readonly<Record<string, string>> = {
  '30': 'black', '31': 'red', '32': 'green', '33': 'yellow', '34': 'blue', '35': 'magenta', '36': 'cyan', '37': 'white',
  '90': 'gray', '91': 'redBright', '92': 'greenBright', '93': 'yellowBright', '94': 'blueBright', '95': 'magentaBright', '96': 'cyanBright', '97': 'whiteBright',
};

type AttributeRole = 'strong' | 'emphasis' | 'strike';
const WORKLINE_ROLE_MAP: Readonly<Record<Exclude<WorklineInkRole, AttributeRole>, PaletteRole>> = {
  model: 'model', provider: 'provider',
  accent: 'accent',
  muted: 'muted',
  user: 'success',
  assistant: 'info',
  error: 'error',
  code: 'code',
  link: 'link',
  info: 'info',
  success: 'success',
  warning: 'warning',
  userBar: 'userBar',
  userLabel: 'userLabel',
  assistantLabel: 'assistantLabel',
  workerCard: 'workerCard',
  windowBorder: 'windowBorder',
  windowTitle: 'windowTitle',
  focus: 'focus',
  selection: 'selection',
  diffAdded: 'diffAdded',
  diffRemoved: 'diffRemoved',
  modeIndicator: 'modeIndicator',
  sectionHeader: 'sectionHeader',
  keyLabel: 'keyLabel',
  mutedId: 'mutedId',
  chipOk: 'chipOk',
  chipWarn: 'chipWarn',
  chipFail: 'chipFail',
  systemLabel: 'systemLabel',
  systemRail: 'systemRail',
  stateConnected: 'stateConnected',
  stateDisconnected: 'stateDisconnected',
};
/** Text attributes carry emphasis on every host theme; the `none` tier (NO_COLOR) drops them with the colours. */
const ATTRIBUTE_ROLES: Readonly<Record<AttributeRole, InkRoleStyle>> = { strong: { bold: true }, emphasis: { italic: true }, strike: { strikethrough: true } };

function tierColor(theme: PaletteTheme, role: PaletteRole, tier: ColorTier): string | undefined {
  const entry = THEME_PALETTES[theme][role];
  if (tier === 'truecolor' && entry.hex !== null) return entry.hex;
  if (tier === 'ansi256' && entry.ansi256 !== null) return `ansi256(${entry.ansi256})`;
  if (entry.ansi16 === '') return undefined;
  const name = ANSI16_NAME[entry.ansi16];
  if (name === undefined) throw new Error(`palette role ${role}: unknown ansi16 ${entry.ansi16}`);
  return name;
}

// WCAG 2.2 relative luminance and contrast ratio; xterm 256-colour index → RGB (cube 16–231, gray ramp 232–255).
const channel = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (rgb: readonly number[]) => 0.2126 * channel(rgb[0]!) + 0.7152 * channel(rgb[1]!) + 0.0722 * channel(rgb[2]!);
const hexRgb = (hex: string) => { const value = Number.parseInt(hex.slice(1), 16); return [value >> 16, (value >> 8) & 255, value & 255]; };
const CUBE = [0, 95, 135, 175, 215, 255];
const xtermRgb = (index: number) => index >= 232 ? [8 + 10 * (index - 232), 8 + 10 * (index - 232), 8 + 10 * (index - 232)]
  : [CUBE[Math.floor((index - 16) / 36)]!, CUBE[Math.floor((index - 16) / 6) % 6]!, CUBE[(index - 16) % 6]!];

/** S8 b (VS Code `minimumContrastRatio`): on a reported background, a truecolor role colour below its theme's minimum, a 256 approximation below
 * 4.5:1 (border roles 3:1) is not drawn; the role keeps its attributes on the terminal's own foreground. The 16 colours are the terminal's. */
function readable(theme: PaletteTheme, role: PaletteRole, tier: ColorTier, background: string): boolean {
  const entry = THEME_PALETTES[theme][role];
  const rgb = tier === 'truecolor' && entry.hex !== null ? hexRgb(entry.hex) : tier === 'ansi256' && entry.ansi256 !== null ? xtermRgb(entry.ansi256) : null;
  if (rgb === null) return true;
  const [high, low] = [luminance(rgb), luminance(hexRgb(background))].sort((a, b) => b - a) as [number, number];
  return (high + 0.05) / (low + 0.05) >= (entry.contrast === 'border' ? 3 : tier === 'truecolor' ? THEME_TEXT_MINIMUM[theme] : 4.5);
}

function roleStyle(theme: PaletteTheme, role: PaletteRole, tier: ColorTier, background: string | undefined): InkRoleStyle {
  if (tier === 'none') return {};
  const entry = THEME_PALETTES[theme][role];
  const style: { color?: string; bold?: boolean; underline?: boolean; inverse?: boolean } = {};
  const color = tierColor(theme, role, tier);
  if (color !== undefined && (background === undefined || readable(theme, role, tier, background))) style.color = color;
  if (entry.attrs.includes('1')) style.bold = true;
  if (entry.attrs.includes('4')) style.underline = true;
  if (entry.attrs.includes('7')) style.inverse = true;
  return style;
}

/** `theme` picks the truecolor/256 values and the ansi16 set; the dark theme is the palette before themes existed. `background` (`#RRGGBB`, the
 * terminal's OSC 11 answer) turns on the contrast guard. */
export function resolveWorklinePalette(tier: ColorTier, theme: PaletteTheme = 'dark', background?: string): WorklineInkPalette {
  const out: Partial<Record<WorklineInkRole, InkRoleStyle>> = {};
  for (const [worklineRole, paletteRole] of Object.entries(WORKLINE_ROLE_MAP) as [WorklineInkRole, PaletteRole][]) {
    out[worklineRole] = Object.freeze(roleStyle(theme, paletteRole, tier, background));
  }
  for (const [role, style] of Object.entries(ATTRIBUTE_ROLES) as [AttributeRole, InkRoleStyle][]) out[role] = Object.freeze(tier === 'none' ? {} : style);
  return Object.freeze(out) as WorklineInkPalette;
}

/** Default host-theme ansi16 mapping for tests and provider fallback. */
export const DEFAULT_INK_PALETTE: WorklineInkPalette = resolveWorklinePalette('ansi16');
