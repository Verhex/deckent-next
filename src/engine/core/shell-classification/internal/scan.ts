import { scanPosixCommand, type ShellScan } from './scanner.js';
import { scanShell, shellWords } from './lenient-scanner.js';

declare const shellScan: unique symbol;
/** A call-local parse token. Results stay private and are reused only for the exact command. */
export interface ShellCommandScan { readonly [shellScan]: true }
const lenient = (command: string) => { const scan = scanShell(command); return { ...scan, words: scan.segments.map(shellWords) }; };
type Scans = { readonly command: string; readonly strict: ShellScan; readonly lenient: ReturnType<typeof lenient> };
const scans = new WeakMap<ShellCommandScan, Scans>();

export function scanShellCommand(command: string): ShellCommandScan {
  const token = Object.freeze({}) as ShellCommandScan;
  scans.set(token, { command, strict: scanPosixCommand(command), lenient: lenient(command) });
  return token;
}
export function strictShellScan(command: string, token?: ShellCommandScan): ShellScan {
  const found = token && scans.get(token);
  return found?.command === command ? found.strict : scanPosixCommand(command);
}
export function lenientShellScan(command: string, token?: ShellCommandScan): ReturnType<typeof lenient> {
  const found = token && scans.get(token);
  return found?.command === command ? found.lenient : lenient(command);
}
