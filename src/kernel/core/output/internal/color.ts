import type { Environment } from '#kernel/core/platform/index.js';
export type ColorTier = 'none' | 'ansi16' | 'ansi256' | 'truecolor';
export interface ColorOptions { noColor?: boolean; env?: Environment; isTTY?: boolean; argv?: readonly string[] }
export function colorTier(options: ColorOptions = {}): ColorTier {
  const env = options.env ?? process.env, force = env['FORCE_COLOR'];
  if (options.noColor || (options.argv ?? process.argv).includes('--no-color') || force === '0') return 'none';
  if (force === undefined && (env['NO_COLOR'] !== undefined || env['TERM']?.trim().toLowerCase() === 'dumb' || !(options.isTTY ?? process.stdout.isTTY))) return 'none';
  if (force === '3') return 'truecolor';
  if (force === '2') return 'ansi256';
  const bg = Number.parseInt(env['COLORFGBG']?.split(';').at(-1) ?? '', 10);
  if (!Number.isInteger(bg) || !(bg === 8 || (bg >= 0 && bg <= 6))) return 'ansi16';
  if (/truecolor|24bit/i.test(env['COLORTERM'] ?? '')) return 'truecolor';
  return env['TERM']?.includes('256') ? 'ansi256' : 'ansi16';
}
export function shouldUseColor(options: ColorOptions = {}): boolean { return colorTier(options) !== 'none'; }
export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
