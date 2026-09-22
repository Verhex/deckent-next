export type ColorTier = 'none' | 'ansi16' | 'ansi256' | 'truecolor';
import { PALETTE, type PaletteRole } from './generated/palette.js';

/** Workline layout roles projected from semantic palette roles. */
export type WorklineInkRole = 'accent' | 'muted' | 'user' | 'assistant' | 'error';

export type InkRoleStyle = Readonly<{ color?: string; bold?: boolean; underline?: boolean; inverse?: boolean; dimColor?: boolean }>;

export type WorklineInkPalette = Readonly<Record<WorklineInkRole, InkRoleStyle>>;

const ANSI16_NAME: Readonly<Record<string, string>> = {
  '30': 'black', '31': 'red', '32': 'green', '33': 'yellow', '34': 'blue', '35': 'magenta', '36': 'cyan', '37': 'white',
  '90': 'gray', '91': 'redBright', '92': 'greenBright', '93': 'yellowBright', '94': 'blueBright', '95': 'magentaBright', '96': 'cyanBright', '97': 'whiteBright',
};

const WORKLINE_ROLE_MAP: Readonly<Record<WorklineInkRole, PaletteRole>> = {
  accent: 'accent',
  muted: 'muted',
  user: 'success',
  assistant: 'info',
  error: 'error',
};

function tierColor(role: PaletteRole, tier: ColorTier): string | undefined {
  const entry = PALETTE[role];
  if (tier === 'truecolor' && entry.hex !== null) return entry.hex;
  if (tier === 'ansi256' && entry.ansi256 !== null) return `ansi256(${entry.ansi256})`;
  if (entry.ansi16 === '') return undefined;
  const name = ANSI16_NAME[entry.ansi16];
  if (name === undefined) throw new Error(`palette role ${role}: unknown ansi16 ${entry.ansi16}`);
  return name;
}

function roleStyle(role: PaletteRole, tier: ColorTier): InkRoleStyle {
  if (tier === 'none') return {};
  const entry = PALETTE[role];
  const style: { color?: string; bold?: boolean; underline?: boolean; inverse?: boolean } = {};
  const color = tierColor(role, tier);
  if (color !== undefined) style.color = color;
  if (entry.attrs.includes('1')) style.bold = true;
  if (entry.attrs.includes('4')) style.underline = true;
  if (entry.attrs.includes('7')) style.inverse = true;
  return style;
}

export function resolveWorklinePalette(tier: ColorTier): WorklineInkPalette {
  const out: Partial<Record<WorklineInkRole, InkRoleStyle>> = {};
  for (const [worklineRole, paletteRole] of Object.entries(WORKLINE_ROLE_MAP) as [WorklineInkRole, PaletteRole][]) {
    out[worklineRole] = Object.freeze(roleStyle(paletteRole, tier));
  }
  return Object.freeze(out) as WorklineInkPalette;
}

/** Default host-theme ansi16 mapping for tests and provider fallback. */
export const DEFAULT_INK_PALETTE: WorklineInkPalette = resolveWorklinePalette('ansi16');
