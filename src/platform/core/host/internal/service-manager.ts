import { closeSync, openSync, readSync } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HOST_LIMITS_REGISTRY } from '#platform/core/common/index.js';
import { ErrorRegistry } from '#platform/core/errors/index.js';
import { serializeJsonDocument, writePinnedFile } from '#platform/core/utils/index.js';
import AUTOMATION from './automation.json' with { type: 'json' };

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
/** One bounded `systemctl --user` command supplied by the adapter (absolute path, no shell, no inherited credentials); resolves with its output. */
export type UserUnitExec = (args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
const showValues = async (exec: UserUnitExec, unit: string, properties: readonly string[]) => Object.fromEntries((await exec(['show',
  ...properties.flatMap(name => ['--property', name]), '--', unit])).stdout.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
/** K4 (i), review M8: the unit's enablement links in the person's user unit folders (configuration and runtime), as `<link> -> <target>`:
 * exactly what `disable` removes (wants/requires/upholds links and aliases), observed before the card and again right before disabling. */
export async function userUnitLinks(unit: string, env: Readonly<Record<string, string | undefined>>): Promise<readonly string[]> {
  const home = env['HOME'], config = env['XDG_CONFIG_HOME'] || (home && join(home, '.config')), found: string[] = [];
  const link = async (path: string, named: boolean) => { const target = await readlink(path).catch(() => null);
    if (target !== null && (named || basename(target) === unit)) found.push(`${path} -> ${target}`); };
  for (const folder of [config && join(config, 'systemd/user'), env['XDG_RUNTIME_DIR'] && join(env['XDG_RUNTIME_DIR'], 'systemd/user')].filter((dir): dir is string => !!dir)) {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) await link(path, false);
      else if (entry.isDirectory() && /\.(wants|requires|upholds)$/u.test(entry.name)) await link(join(path, unit), true);
    }
  }
  return found.sort();
}
/** K4: a user unit Deckent did not create, observed as running this installation's described service. `eligible` only when its main process is that
 * process, nothing else is in its control group, it has no alias or drop-in and its regular unit file declares no Also=/Alias=. Never a system unit.
 * `links`: its exact enablement links, bound into the confirmed plan. */
export async function observeUserUnit(found: { readonly scope: 'user' | 'system'; readonly unit: string }, processId: number, exec: UserUnitExec,
  env: Readonly<Record<string, string | undefined>> = process.env) {
  const command = `systemctl ${found.scope === 'user' ? '--user ' : ''}disable --now ${found.unit}`, values = found.scope === 'user' && process.platform === 'linux'
    ? await showValues(exec, found.unit, ['MainPID', 'ControlGroup', 'FragmentPath', 'Names', 'DropInPaths']).catch(() => null) : null;
  const text = values && readProcessFile(values['FragmentPath'] ?? ''), file = text && await lstat(values['FragmentPath']!).catch(() => null);
  const eligible = !!file && file.isFile() && file.size === Buffer.byteLength(text) && !/^\s*(?:Also|Alias)\s*=\s*\S/mu.test(text) && !values['DropInPaths']
    && values['Names']?.trim() === found.unit && Number(values['MainPID']) === processId
    && readProcessFile(join('/sys/fs/cgroup', values['ControlGroup'] ?? '', 'cgroup.procs'))?.trim() === String(processId);
  return { unitDisable: eligible ? 'eligible' as const : 'command-only' as const, command, links: eligible ? await userUnitLinks(found.unit, env) : [] };
}
/**
 * K4 (d)/(e)/(i), review M7/M8: `disable --now` of the exact user unit after the governed shutdown, only while its links are exactly the confirmed
 * ones (otherwise a typed refusal and nothing is disabled). A durable intent receipt (links, previous enablement and activity, undo) is written
 * before and the real result (systemctl's own messages) after, in `receipts`. The unit file stays; the undo recreates the recorded links.
 */
export async function disableUserUnit(unit: string, exec: UserUnitExec, expected: readonly string[], receipts: string, env: Readonly<Record<string, string | undefined>> = process.env) {
  const command = `systemctl --user disable --now ${unit}`, refuse = () => ErrorRegistry.createError('UNINSTALL_SERVICE_RUNNING', { params: { unit, command } });
  const links = await userUnitLinks(unit, env);
  if (JSON.stringify(links) !== JSON.stringify(expected)) throw refuse();
  const values = await showValues(exec, unit, ['UnitFileState', 'ActiveState']), previous = values['UnitFileState'] ?? 'unknown', active = values['ActiveState'] ?? 'unknown';
  const undo = [...links.map(entry => { const [path, target] = entry.split(' -> '); return `ln -s '${target}' '${path}'`; }), 'systemctl --user daemon-reload',
    ...(active === 'active' ? [`systemctl --user start ${unit}`] : [])].join(' && ');
  // R14: receipts go through their pinned parent (a linked recovery folder is refused before anything is disabled).
  const receipt = (phase: string, body: object) => writePinnedFile(join(receipts, AUTOMATION.unitReceipt.replace('{unit}', unit).replace('{phase}', phase)),
    Buffer.from(serializeJsonDocument({ schemaVersion: 1, unit, previous, active, links, undo, ...body })), undefined, () => true);
  await receipt('intent', {});
  const outcome = await exec(['disable', '--now', '--', unit]).then(out => ({ ok: true, stderr: out.stderr }),
    (error: { stderr?: unknown; message?: string }) => ({ ok: false, stderr: String(error.stderr ?? error.message ?? '') }));
  await receipt('result', outcome);
  if (!outcome.ok) throw refuse();
  return { unit, previous, undo, links };
}
