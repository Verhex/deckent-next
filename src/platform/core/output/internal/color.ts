import type { Environment } from '#platform/core/host/index.js';
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
/**
 * Untrusted text (command output, worker reports, files of another install) is shown only through this: before it reaches the owner's terminal every escape sequence (CSI, OSC, other ESC forms) and every
 * control character except newline and tab is removed, and carriage returns become line breaks — nothing a command prints can move
 * the cursor, retitle the window, write the clipboard or hide text.
 */
// Matching control characters is the point of these patterns (untrusted command output).
// eslint-disable-next-line no-control-regex
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/gu;
// eslint-disable-next-line no-control-regex
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
/** Any other escape: ESC, optional intermediate bytes, one final byte (ECMA-48), e.g. ESC 7, ESC ( B, ESC c. */
// eslint-disable-next-line no-control-regex
const OTHER_ESCAPE = /\u001b[ -/]*[0-~]?/gu;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
export function terminalSafeText(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(OTHER_ESCAPE, '').replace(/\r\n?/gu, '\n').replace(CONTROL, '');
}
/**
 * Where untrusted text may be cut before `terminalSafeText` without changing what it shows: just after the last newline that survives it.
 * A newline inside an OSC (including one still open at the end, which runs to BEL, ST or the next ESC) is removed with it and ends no
 * line. Text up to this point projects alone exactly as it does inside the whole, so a single-line value is never split between two cuts.
 */
export function terminalLineEnd(text: string): number {
  return text.replace(OSC, match => ' '.repeat(match.length)).lastIndexOf('\n') + 1;
}
