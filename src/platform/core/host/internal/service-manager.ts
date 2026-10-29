import { closeSync, openSync, readSync } from 'node:fs';
import { HOST_LIMITS_REGISTRY } from '#platform/core/common/index.js';
import { ErrorRegistry } from '#platform/core/errors/index.js';

/** A service manager that runs a process: systemd places a unit's processes in the unit's control group (`<name>.service`) and names one main process. */
export interface ServiceManagerUnit { readonly manager: 'systemd'; readonly scope: 'user' | 'system'; readonly unit: string }
/** Reads one process file as text, bounded; null when it cannot be read (other host, other user, no /proc). */
export type ProcessFileReader = (path: string) => string | null;
const READ_BYTES = HOST_LIMITS_REGISTRY.processFileReadBytes;
const UNIT_SEGMENT = /^(?!user@)[^\s]+\.service$/;
const USER_MANAGER = /\/user@[^/]+\.service\//;

export const readProcessFile: ProcessFileReader = path => {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r'); const buffer = Buffer.alloc(READ_BYTES);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, READ_BYTES, 0));
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing left to release */ } }
};
/** The unit's main process as its manager reports it (`systemctl show -p MainPID`), or null when the manager does not answer within its bound. */
export type ServiceMainPidQuery = (unit: ServiceManagerUnit) => Promise<number | null>;
/** The bounds of one main-process query to the manager (host-limits registry). */
export const SERVICE_MANAGER_QUERY_BOUNDS = Object.freeze({ timeoutMs: HOST_LIMITS_REGISTRY.serviceManagerQueryTimeoutMs,
  outputBytes: HOST_LIMITS_REGISTRY.serviceManagerQueryOutputBytes });
/** The unit whose control group holds process `pid`: only a candidate (any process a unit starts, and its descendants, stay in its group). The
 * control group is the only file read (never the environment, which can hold credentials): a `.service` unit leaf counts; the `user@<uid>.service`
 * manager itself and `.scope` leaves (login sessions, terminal `app-*.scope`, `init.scope`) never do. */
function candidateUnit(pid: number, read: ProcessFileReader): ServiceManagerUnit | null {
  const cgroup = read(`/proc/${pid}/cgroup`);
  if (!cgroup) return null;
  const segments = cgroup.split('\n')[0]!.split('/').filter(Boolean), unit = segments.filter(segment => UNIT_SEGMENT.test(segment)).at(-1);
  return unit && !segments.at(-1)?.endsWith('.scope') ? { manager: 'systemd', scope: USER_MANAGER.test(cgroup) ? 'user' : 'system', unit } : null;
}
/**
 * The manager unit that runs process `pid`, or null when it is not provably manager-run (hand-started, unreadable, another host). CI-108: the
 * process must BE the candidate unit's main process, as the manager reports it; a process that merely runs inside a unit's control group (a
 * service started from a CI job inside the runner agent's unit, or from any shell a unit runs) is not, so its terminal restart stays available.
 * An unanswered query is not proof: the guard then stays off, as for an unreadable control group.
 */
export async function detectServiceManager(pid: number | undefined, mainPid: ServiceMainPidQuery,
  read: ProcessFileReader = readProcessFile): Promise<ServiceManagerUnit | null> {
  const candidate = pid === undefined ? null : candidateUnit(pid, read);
  if (!candidate) return null;
  return await mainPid(candidate).catch(() => null) === pid ? candidate : null;
}
/** The operator command that restarts the unit through its manager. */
export const serviceManagerRestartCommand = (found: ServiceManagerUnit): string =>
  `systemctl ${found.scope === 'user' ? '--user ' : ''}restart ${found.unit}`;
/** The operator command that stops the unit through its manager (a stop elsewhere leaves the manager believing it simply finished). */
export const serviceManagerStopCommand = (found: ServiceManagerUnit): string => `systemctl ${found.scope === 'user' ? '--user ' : ''}stop ${found.unit}`;
/**
 * F3: the one stop check every caller surface shares (the CLI unless the person's `--force`, MCP, the SDK), before any shutdown request
 * is sent: a runtime service its manager runs is stopped through that manager, else the next terminal starts a second, unmanaged service.
 * A lookup that fails rejects; it never means "not managed". Uninstall's governed stop under K4 custody does not pass here (it stops such
 * a service on purpose, before it disables the unit).
 */
export async function assertRuntimeServiceStoppable(processId: number | undefined,
  managerOf: (pid: number | undefined) => Promise<ServiceManagerUnit | null>): Promise<void> {
  const managed = await managerOf(processId);
  if (!managed) return;
  throw ErrorRegistry.createError('RUNTIME_SERVICE_EXTERNALLY_MANAGED', { params: { command: serviceManagerStopCommand(managed), action: 'stop' } });
}
