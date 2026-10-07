import { envValue, type Environment } from './env.js';

/** WSL drvfs mounts a Windows drive at `/mnt/<letter>` (lower-case); `/mnt/C` and `/mnt/c` name the same root there. On plain Linux the
 * letter case is significant and nothing is folded. */
export function isWslHost(platform: string, env: Environment): boolean {
  return platform === 'wsl' || (platform === 'linux' && !!(envValue(env, 'WSL_DISTRO_NAME') || envValue(env, 'WSL_INTEROP')));
}
const DRIVE_SEGMENT = /^\/mnt\/([A-Za-z])(?=\/|$)/;
/** Canonical spelling of a WSL drive-mount path: only the drive-letter segment is lower-cased, the rest keeps its case. */
export function foldWslDrivePath(path: string): string {
  return path.replace(DRIVE_SEGMENT, (_match, letter: string) => '/mnt/' + letter.toLowerCase());
}
