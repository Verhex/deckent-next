import type { Environment } from './env.js';
import { detectWslLinux, type KernelIdentityReader } from './wsl-detect.js';

/** WSL drvfs mounts a Windows drive at `/mnt/<letter>` (lower-case); `/mnt/C` and `/mnt/c` name the same root there. On plain Linux the
 * letter case is significant and nothing is folded. */
export function isWslHost(platform: string, env: Environment, kernel?: KernelIdentityReader): boolean {
  return platform === 'wsl' || (platform === 'linux' && detectWslLinux(env, kernel));
}
const DRIVE_SEGMENT = /^\/mnt\/([A-Za-z])(?=\/|$)/;
/** Canonical spelling of a WSL drive-mount path: only the drive-letter segment is lower-cased, the rest keeps its case. */
export function foldWslDrivePath(path: string): string {
  return path.replace(DRIVE_SEGMENT, (_match, letter: string) => '/mnt/' + letter.toLowerCase());
}
