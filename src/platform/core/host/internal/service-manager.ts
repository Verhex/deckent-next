import { closeSync, openSync, readSync } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { HOST_LIMITS_REGISTRY } from '#platform/core/common/index.js';
import { ErrorRegistry } from '#platform/core/errors/index.js';
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
/** The operator command that stops the unit through its manager (a stop elsewhere leaves the manager believing it simply finished). */
export const serviceManagerStopCommand = (found: ServiceManagerUnit): string => `systemctl ${found.scope === 'user' ? '--user ' : ''}stop ${found.unit}`;
/** One bounded `systemctl --user` command supplied by the adapter (absolute path, no shell, no inherited credentials); resolves with its output. */
export type UserUnitExec = (args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
const showValues = async (exec: UserUnitExec, unit: string, properties: readonly string[]) => Object.fromEntries((await exec(['show',
  ...properties.flatMap(name => ['--property', name]), '--', unit])).stdout.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
/** K4 (i), review M8/R5/F5: the unit's enablement links in the person's user unit folders (configuration, then runtime), as `<link> -> <target>`:
 * every link `systemctl disable` matches, walking every subfolder as it does (systemd v255 install.c): its name is the unit, its target (written
 * or chased to the end) names it, or its target is a link already matched, repeated until nothing joins. A folder that cannot be read (other
 * than an absent top folder) is unknown: it throws, never an empty list. */
export async function userUnitLinks(unit: string, env: Readonly<Record<string, string | undefined>>): Promise<readonly string[]> {
  const home = env['HOME'], config = env['XDG_CONFIG_HOME'] || (home && join(home, '.config')), found: { path: string; target: string; to: string; chased: string }[] = [];
  let seen = 0;
  const walk = async (folder: string, top: boolean): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (top && error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (++seen > AUTOMATION.unitLinkEntries) throw new Error('UNIT_LINKS_UNBOUNDED');
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path, false);
      else if (entry.isSymbolicLink()) { const target = await readlink(path); found.push({ path, target, to: resolve(folder, target), chased: await realpath(path) }); }
    }
  };
  for (const folder of [config && join(config, 'systemd/user'), env['XDG_RUNTIME_DIR'] && join(env['XDG_RUNTIME_DIR'], 'systemd/user')]) if (folder) await walk(folder, true);
  const matched = new Set<string>(), joins = (link: typeof found[number]) => basename(link.path) === unit || basename(link.target) === unit || basename(link.chased) === unit || matched.has(link.to);
  for (let grew = true; grew;) { grew = false; for (const link of found) if (!matched.has(link.path) && joins(link)) { matched.add(link.path); grew = true; } }
  return found.filter(link => matched.has(link.path)).map(link => `${link.path} -> ${link.target}`);
}
/** F2: the user unit search path of systemd.unit(5) (v255), in precedence order (earlier entries override later files of the same name). */
function userUnitSearchPath(env: Readonly<Record<string, string | undefined>>, home: string) {
  const config = env['XDG_CONFIG_HOME'] || join(home, '.config'), run = env['XDG_RUNTIME_DIR'], at = (...parts: string[]) => run ? [join(run, 'systemd', ...parts)] : [];
  const each = (value: string | undefined, fallback: string) => (value || fallback).split(':').filter(Boolean).map(dir => join(dir, 'systemd/user'));
  return [join(config, 'systemd/user.control'), ...at('user.control'), ...at('transient'), ...at('generator.early'), join(config, 'systemd/user'), ...each(env['XDG_CONFIG_DIRS'], '/etc/xdg'),
    '/etc/systemd/user', ...at('user'), '/run/systemd/user', ...at('generator'), join(env['XDG_DATA_HOME'] || join(home, '.local/share'), 'systemd/user'),
    ...each(env['XDG_DATA_DIRS'], '/usr/local/share:/usr/share'), '/usr/local/lib/systemd/user', '/usr/lib/systemd/user', ...at('generator.late')];
}
/** F2: the unit file `systemctl disable` resolves from disk (not the manager's loaded copy): the first entry named after the unit along the search
 * path, only when it is a regular file and no drop-in folder (`<unit>.d`, its `-` prefixes, `service.d`) exists anywhere; else null. A read error throws. */
async function effectiveUnitFile(unit: string, env: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  const home = env['HOME'], parts = unit.slice(0, -'.service'.length).split('-');
  if (!home || unit.includes('@') || !unit.endsWith('.service')) return null; // an instance's template resolution is not modelled: command only
  const dropIns = [`${unit}.d`, 'service.d', ...parts.slice(1).map((_, index) => `${parts.slice(0, index + 1).join('-')}-.service.d`)];
  let first: string | null | undefined;
  for (const dir of userUnitSearchPath(env, home)) for (const name of [unit, ...dropIns]) {
    const info = await lstat(join(dir, name)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
    if (info && name !== unit) return null;
    if (info && first === undefined) first = info.isFile() ? join(dir, name) : null;
  }
  return first ?? null;
}
/** R3, F2: the unit file evidence `disable` acts on, read without its process: the manager's fragment is the one resolved from disk, a regular file,
 * its only name, no drop-in, no Also=/Alias=; the digest binds its path and bytes. Null when any of that does not hold. */
export async function userUnitFile(unit: string, exec: UserUnitExec, env: Readonly<Record<string, string | undefined>> = process.env) {
  const values = await showValues(exec, unit, ['FragmentPath', 'Names', 'DropInPaths']).catch(() => null), text = values && readProcessFile(values['FragmentPath'] ?? '');
  const file = text && await effectiveUnitFile(unit, env).catch(() => null) === values['FragmentPath'] && await lstat(values['FragmentPath']!).catch(() => null);
  return file && file.isFile() && file.size === Buffer.byteLength(text) && !/^\s*(?:Also|Alias)\s*=\s*\S/mu.test(text) && !values['DropInPaths'] && values['Names']?.trim() === unit
    ? createHash('sha256').update(`${values['FragmentPath']}\0${text}`).digest('hex') : null;
}
/** A systemd unit observation cannot prove manager-owned resolution or prevent a new instance; expose only the manual command. */
export async function observeUserUnit(found: { readonly scope: 'user' | 'system'; readonly unit: string }, _processId: number, _exec: UserUnitExec,
  _env?: Readonly<Record<string, string | undefined>>) {
  void _processId; void _exec; void _env;
  const command = `systemctl ${found.scope === 'user' ? '--user ' : ''}disable --now ${found.unit}`;
  return { unitDisable: 'command-only' as const, command, links: [], unitFile: null };
}
/** F2/F4/F5: no manager-owned resolution or admission fence is available. Never execute a disable from a caller's observation;
 * even an earlier eligible plan must take the same command-only refusal. The person performs the displayed command separately. */
export async function disableUserUnit(expected: { readonly unit: string | null; readonly links?: readonly string[] | undefined; readonly unitFile?: string | null | undefined },
  _exec: UserUnitExec, _receipts: string, _env?: Readonly<Record<string, string | undefined>>): Promise<{ unit: string; previous: string; undo: string; links: readonly string[] }> {
  void _exec; void _receipts; void _env;
  const unit = expected.unit ?? '', command = `systemctl --user disable --now ${unit}`;
  throw ErrorRegistry.createError('UNINSTALL_SERVICE_RUNNING', { params: { unit, command } });
}
