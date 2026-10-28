import { closeSync, openSync, readSync } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
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
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** K4 (i), review M8/R5: the unit's enablement links in the person's user unit folders (configuration, then runtime), as `<link> -> <target>`:
 * every link `systemctl disable` matches, walking every subfolder as it does: its name is the unit or its target names it. A folder that
 * cannot be read (other than an absent top folder) is unknown: it throws, never an empty list. */
export async function userUnitLinks(unit: string, env: Readonly<Record<string, string | undefined>>): Promise<readonly string[]> {
  const home = env['HOME'], config = env['XDG_CONFIG_HOME'] || (home && join(home, '.config')), found: string[] = [];
  let seen = 0;
  const walk = async (folder: string, top: boolean): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (top && error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (++seen > AUTOMATION.unitLinkEntries) throw new Error('UNIT_LINKS_UNBOUNDED');
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path, false);
      else if (entry.isSymbolicLink()) { const target = await readlink(path); if (entry.name === unit || basename(target) === unit) found.push(`${path} -> ${target}`); }
    }
  };
  for (const folder of [config && join(config, 'systemd/user'), env['XDG_RUNTIME_DIR'] && join(env['XDG_RUNTIME_DIR'], 'systemd/user')]) if (folder) await walk(folder, true);
  return found;
}
const runtimeLinked = (links: readonly string[], env: Readonly<Record<string, string | undefined>>) =>
  !!env['XDG_RUNTIME_DIR'] && links.some(entry => entry.startsWith(join(env['XDG_RUNTIME_DIR']!, 'systemd/user/')));
/** R3: the unit file evidence `disable` acts on, read without its process: a regular fragment, its only name, no drop-in, no Also=/Alias=;
 * the digest binds its path and bytes. Null when any of that does not hold. */
export async function userUnitFile(unit: string, exec: UserUnitExec) {
  const values = await showValues(exec, unit, ['FragmentPath', 'Names', 'DropInPaths']).catch(() => null), text = values && readProcessFile(values['FragmentPath'] ?? '');
  const file = text && await lstat(values['FragmentPath']!).catch(() => null);
  return file && file.isFile() && file.size === Buffer.byteLength(text) && !/^\s*(?:Also|Alias)\s*=\s*\S/mu.test(text) && !values['DropInPaths'] && values['Names']?.trim() === unit
    ? createHash('sha256').update(`${values['FragmentPath']}\0${text}`).digest('hex') : null;
}
/** K4: a user unit Deckent did not create, observed as running this installation's described service. `eligible` only when its main process is that
 * process, nothing else is in its control group, its unit file evidence holds (above) and none of its links is a runtime one (a persistent
 * `disable` keeps those: R5). Never a system unit. `links` and `unitFile`: bound into the confirmed plan. */
export async function observeUserUnit(found: { readonly scope: 'user' | 'system'; readonly unit: string }, processId: number, exec: UserUnitExec,
  env: Readonly<Record<string, string | undefined>> = process.env) {
  const command = `systemctl ${found.scope === 'user' ? '--user ' : ''}disable --now ${found.unit}`, user = found.scope === 'user' && process.platform === 'linux';
  const values = user ? await showValues(exec, found.unit, ['MainPID', 'ControlGroup']).catch(() => null) : null, file = values && await userUnitFile(found.unit, exec);
  const links = file ? await userUnitLinks(found.unit, env).catch(() => null) : null;
  const eligible = !!links && !runtimeLinked(links, env) && Number(values!['MainPID']) === processId
    && readProcessFile(join('/sys/fs/cgroup', values!['ControlGroup'] ?? '', 'cgroup.procs'))?.trim() === String(processId);
  return { unitDisable: eligible ? 'eligible' as const : 'command-only' as const, command, links: eligible ? links : [], unitFile: eligible ? file : null };
}
/**
 * K4 (d)/(e)/(i), review M7/M8, R3/R5: `disable --now` of the exact user unit, after the governed shutdown and the service's absence, only while
 * its unit file evidence and links are exactly the confirmed ones, read again right before (otherwise a typed refusal and nothing is disabled).
 * A durable intent receipt (links, previous state, undo) is written before and the real result after: systemctl's own messages and the links
 * that are actually gone (read again), with the undo that recreates exactly those. The unit file stays.
 */
export async function disableUserUnit(expected: { readonly unit: string | null; readonly links?: readonly string[] | undefined; readonly unitFile?: string | null | undefined },
  exec: UserUnitExec, receipts: string, env: Readonly<Record<string, string | undefined>> = process.env) {
  const unit = expected.unit ?? '', command = `systemctl --user disable --now ${unit}`, refuse = () => ErrorRegistry.createError('UNINSTALL_SERVICE_RUNNING', { params: { unit, command } });
  const links = await userUnitLinks(unit, env).catch(() => null);
  if (!links || runtimeLinked(links, env) || JSON.stringify(links) !== JSON.stringify(expected.links ?? []) || !expected.unitFile || await userUnitFile(unit, exec) !== expected.unitFile) throw refuse();
  const values = await showValues(exec, unit, ['UnitFileState', 'ActiveState']), previous = values['UnitFileState'] ?? 'unknown', active = values['ActiveState'] ?? 'unknown';
  if (!['inactive', 'failed'].includes(active)) throw refuse(); // F4: an instance that started since the last absence check is never stopped by --now
  const undoOf = (gone: readonly string[]) => [...gone.map(entry => { const [path = '', target = ''] = entry.split(' -> ');
    return `mkdir -p ${quote(dirname(path))} && ln -sfn ${quote(target)} ${quote(path)}`; }), 'systemctl --user daemon-reload'].join(' && ');
  // R14, F1: receipts go through their pinned parent; only an earlier receipt of this unit is replaced, any other file there stays (refusal).
  const own = (bytes: Buffer) => { try { const body = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; return body['schemaVersion'] === 1 && body['unit'] === unit; } catch { return false; } };
  const receipt = (phase: string, body: object) => writePinnedFile(join(receipts, AUTOMATION.unitReceipt.replace('{unit}', unit).replace('{phase}', phase)),
    Buffer.from(serializeJsonDocument({ schemaVersion: 1, unit, previous, active, ...body })), undefined, own);
  await receipt('intent', { links, undo: undoOf(links) });
  const outcome = await exec(['disable', '--now', '--', unit]).then(out => ({ ok: true, stderr: out.stderr }),
    (error: { stderr?: unknown; message?: string }) => ({ ok: false, stderr: String(error.stderr ?? error.message ?? '') }));
  const after = await userUnitLinks(unit, env).catch(() => null), gone = after ? links.filter(entry => !after.includes(entry)) : links, undo = undoOf(gone);
  await receipt('result', { ...outcome, links: gone, linksAfter: after, undo });
  if (!outcome.ok) throw refuse();
  return { unit, previous, undo, links: gone };
}
