import { closeSync, openSync, readSync } from 'node:fs';
import { HOST_LIMITS_REGISTRY } from '#platform/core/common/index.js';

/** A service manager that runs a process: systemd marks every unit's processes with `INVOCATION_ID` and places them in the unit's control group. */
export interface ServiceManagerUnit { readonly manager: 'systemd'; readonly scope: 'user' | 'system'; readonly unit: string }
/** Reads one process file as text, bounded; null when it cannot be read (other host, other user, no /proc). */
export type ProcessFileReader = (path: string) => string | null;
const READ_BYTES = HOST_LIMITS_REGISTRY.processFileReadBytes;
const MARKER = 'INVOCATION_ID=';
const UNIT_SEGMENT = /^(?!user@)[^\s]+\.service$/;
const USER_MANAGER = /\/user@[^/]+\.service\//;

export const readProcessFile: ProcessFileReader = path => {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r'); const buffer = Buffer.alloc(READ_BYTES);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, READ_BYTES, 0));
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing left to release */ } }
};
/**
 * The manager unit that runs process `pid`, or null when it is not provably manager-run (hand-started, unreadable, another host or no
 * systemd marker). Proof needs both the marker in the process environment and a service unit in its control group, so a login scope never
 * reads as managed. Existing facts of the process only: no service response field is involved.
 */
export function detectServiceManager(pid: number | undefined, read: ProcessFileReader = readProcessFile): ServiceManagerUnit | null {
  if (pid === undefined) return null;
  const environment = read(`/proc/${pid}/environ`), cgroup = read(`/proc/${pid}/cgroup`);
  if (!environment || !cgroup || !environment.split('\0').some(entry => entry.startsWith(MARKER) && entry.length > MARKER.length)) return null;
  const unit = cgroup.split(/[/\n]/).filter(segment => UNIT_SEGMENT.test(segment)).at(-1);
  return unit ? { manager: 'systemd', scope: USER_MANAGER.test(cgroup) ? 'user' : 'system', unit } : null;
}
/** The operator command that restarts the unit through its manager. */
export const serviceManagerRestartCommand = (found: ServiceManagerUnit): string =>
  `systemctl ${found.scope === 'user' ? '--user ' : ''}restart ${found.unit}`;
