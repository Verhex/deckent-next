import { constants } from 'node:fs';
import { HOST_LIMITS_REGISTRY } from '#platform/core/common/index.js';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { ErrorRegistry } from '#platform/core/errors/index.js';
import { openPinnedParent, readPinnedFile, writePinnedFile } from '#platform/core/utils/index.js';
import { readProcessFile, type ProcessFileReader } from './service-manager.js';
import AUTOMATION from './automation.json' with { type: 'json' };
/** Versioned fragment trust invariant: group/other write bits must stay clear. */
const UNIT_FRAGMENT_UNTRUSTED_WRITE_MASK: number = 0o022;
/** Absolute executable, no shell, bounded output and duration; manager queries share the same user bus. */
export type UserUnitExec = (args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
/** GetUnitFileLinks(unit, runtime=false): systemd's own disable dry-run, never a caller-env scan. */
export type UserUnitLinkQuery = ((unit: string) => Promise<readonly string[]>) & { processes?(unit: string): Promise<readonly number[]> };
const validUnit = (unit: string) => /^[a-zA-Z0-9_.:-]+\.service$/u.test(unit) && !unit.includes('@');
const values = async (exec: UserUnitExec, unit: string | null, properties: readonly string[]) => Object.fromEntries((await exec(['show',
  ...properties.flatMap(name => ['--property', name]), ...(unit ? ['--', unit] : [])])).stdout.trim().split('\n').map(line => {
  const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safePath = (path: string) => isAbsolute(path) && !/[\s"\\]/u.test(path) && !path.includes(' -> ');
/** Exact links from the effect owner, with their existing targets (dangling targets are valid). */
export async function userUnitLinks(unit: string, query: UserUnitLinkQuery): Promise<readonly string[]> {
  const paths = [...await query(unit)].sort();
  if (paths.length > 64 || new Set(paths).size !== paths.length || paths.some(path => !safePath(path))) throw new Error('UNIT_LINKS_UNPROVEN');
  return Promise.all(paths.map(async path => { const target = await readlink(path);
    if (/[\r\n]/u.test(target) || target.includes(' -> ')) throw new Error('UNIT_LINKS_UNPROVEN'); return `${path} -> ${target}`; }));
}
/** Unit fragments are only read: a vendor-owned fragment is valid too. Pin its parent and descriptor, and bound the read. */
async function fragmentDigest(path: string) {
  const parent = await openPinnedParent(path); if (!parent) return null;
  try {
    const file = await open(`/proc/self/fd/${parent.fd}/${basename(path)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > HOST_LIMITS_REGISTRY.processFileReadBytes || before.mode & UNIT_FRAGMENT_UNTRUSTED_WRITE_MASK) return null;
      const bytes = Buffer.alloc(before.size + 1), read = await file.read(bytes, 0, bytes.length, 0), after = await file.stat(), named = await lstat(path);
      if (read.bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || !named.isFile() || named.dev !== before.dev || named.ino !== before.ino) return null;
      const text = bytes.subarray(0, read.bytesRead).toString('utf8');
      return /^\s*(?:Also|Alias)\s*=/mu.test(text) ? null : digest(bytes.subarray(0, read.bytesRead));
    } finally { await file.close(); }
  } finally { await parent.close(); }
}
/** Bind the loaded fragment to the manager's own search path and current disk resolution; unsupported overrides refuse. */
async function fileEvidence(unit: string, exec: UserUnitExec) {
  const state = await values(exec, unit, ['FragmentPath', 'Names', 'DropInPaths', 'NeedDaemonReload', 'LoadState']);
  const manager = await values(exec, null, ['UnitPath']), paths = manager['UnitPath']?.split(' ');
  if (!validUnit(unit) || !paths?.length || paths.some(path => !safePath(path)) || state['LoadState'] !== 'loaded'
    || state['NeedDaemonReload'] !== 'no' || state['DropInPaths'] !== '' || state['Names'] !== unit) return null;
  const parts = unit.slice(0, -'.service'.length).split('-'), drops = [`${unit}.d`, 'service.d',
    ...parts.slice(1).map((_, index) => `${parts.slice(0, index + 1).join('-')}-.service.d`)];
  let effective: string | null = null;
  for (const dir of paths) for (const name of [unit, ...drops]) {
    const path = join(dir, name), info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
    if (!info) continue;
    if (name !== unit || !(info.isFile() || info.isSymbolicLink())) return null;
    effective ??= path;
  }
  if (!effective) return null;
  const resolved = await realpath(effective);
  if (effective !== state['FragmentPath'] && resolved !== state['FragmentPath']) return null;
  const file = await fragmentDigest(resolved);
  return file ? digest([effective, resolved, file, paths]) : null;
}
export const userUnitFile = (unit: string, exec: UserUnitExec) => fileEvidence(unit, exec).catch(() => null);
const groupOnly = (group: string | undefined, pid: number, read: ProcessFileReader) => {
  if (!group || !group.startsWith('/') || group.includes('..')) return false;
  const members = read(`/sys/fs/cgroup${group}/cgroup.procs`);
  return members !== null && members.trim() === String(pid);
};
/** K4 observation of the service's sole main process, through its running manager. */
export async function observeUserUnit(found: { readonly scope: 'user' | 'system'; readonly unit: string }, processId: number, exec: UserUnitExec,
  query?: UserUnitLinkQuery, read: ProcessFileReader = readProcessFile) {
  const command = `systemctl ${found.scope === 'user' ? '--user ' : ''}disable --now ${found.unit}`;
  const refused = { unitDisable: 'command-only' as const, command, links: [] as readonly string[], unitFile: null };
  if (found.scope !== 'user' || !query || !validUnit(found.unit)) return refused;
  try {
    const state = await values(exec, found.unit, ['MainPID', 'ControlGroup', 'ActiveState']), unitFile = await userUnitFile(found.unit, exec);
    const alone = query.processes ? JSON.stringify(await query.processes(found.unit)) === JSON.stringify([processId]) : groupOnly(state['ControlGroup'], processId, read);
    if (Number(state['MainPID']) !== processId || state['ActiveState'] !== 'active' || !alone || !unitFile) return refused;
    return { unitDisable: 'eligible' as const, command, links: await userUnitLinks(found.unit, query), unitFile };
  } catch { return refused; }
}
/** The caller holds the service owner's exclusive ledger custody until uninstall completes; a mere inactive observation is insufficient. */
export interface UserUnitFence { assert(): Promise<void> }
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** K4: pinned receipts, fresh manager resolution and absence under custody; exact changed links determine undo, never `enable --now`. */
export async function disableUserUnit(expected: { readonly unit: string | null; readonly links?: readonly string[] | undefined; readonly unitFile?: string | null | undefined },
  exec: UserUnitExec, receipts: string, query?: UserUnitLinkQuery, fence?: UserUnitFence): Promise<{ unit: string; previous: string; undo: string; links: readonly string[] }> {
  const unit = expected.unit ?? '', command = `systemctl --user disable --now ${unit}`;
  const refused = (reason: string): never => { throw ErrorRegistry.createError('UNINSTALL_SERVICE_RUNNING', { params: { unit, command, reason } }); };
  if (!validUnit(unit) || !query || !fence || !expected.unitFile || !expected.links) return refused('manager-evidence-or-custody-missing');
  const check = async () => {
    await fence.assert();
    const state = await values(exec, unit, ['MainPID', 'ActiveState', 'UnitFileState', 'ControlGroup']);
    if (state['MainPID'] !== '0' || !['inactive', 'failed'].includes(state['ActiveState'] ?? '') || (query.processes ? (await query.processes(unit)).length > 0 : !!state['ControlGroup'])) return refused('new-instance-or-group');
    if (await userUnitFile(unit, exec) !== expected.unitFile || JSON.stringify(await userUnitLinks(unit, query)) !== JSON.stringify(expected.links)) return refused('manager-view-changed');
    return state;
  };
  const state = await check(), links = [...expected.links], previous = state['UnitFileState'] ?? 'unknown';
  const restore = (members: readonly string[]) => members.map(link => { const [path, target] = link.split(' -> '); return `mkdir -p -- ${quoted(dirname(path!))} && ln -s -- ${quoted(target!)} ${quoted(path!)}`; }).join(' && ') || ':';
  const undo = restore(links), removed = (output: { stdout: string; stderr: string }) => [...`${output.stdout}\n${output.stderr}`.matchAll(/^Removed "([^"\n]+)"\.$/gmu)].map(match => match[1]!).sort();
  const actualUndo = (changed: readonly string[]) => changed.length && changed.every(path => links.some(link => link.split(' -> ')[0] === path))
    ? restore(links.filter(link => changed.includes(link.split(' -> ')[0]!))) : null;
  const receipt = async (phase: string, body: unknown) => {
    const path = join(receipts, AUTOMATION.unitReceipt.replace('{unit}', unit).replace('{phase}', phase)), bytes = Buffer.from(JSON.stringify(body));
    // Only byte-identical replay belongs to this intent; a foreign receipt is never replaced.
    try { await writePinnedFile(path, bytes, undefined, current => current.equals(bytes)); } catch { return refused('receipt-not-owned'); }
  };
  const intent = { schemaVersion: 2, unit, unitFile: expected.unitFile, previous, links, undo };
  const resultPath = join(receipts, AUTOMATION.unitReceipt.replace('{unit}', unit).replace('{phase}', 'result'));
  if (await readPinnedFile(resultPath).catch(() => true)) return refused('receipt-already-exists');
  await receipt('intent', intent);
  await check(); // receipt I/O is inside the held startup fence
  let output: { stdout: string; stderr: string };
  try { output = await exec(['disable', '--now', '--', unit]); } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const reported = { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }, changed = removed(reported);
    await receipt('result', { ...intent, outcome: 'unknown', changed, undo: actualUndo(changed), output: reported });
    return refused('disable-outcome-unknown');
  }
  const changed = removed(output);
  await receipt('result', { ...intent, changed, undo: changed.length ? actualUndo(changed) : ':', output }); // retain actual manager report even on an uncertain/mismatched effect
  if (JSON.stringify(changed) !== JSON.stringify(links.map(link => link.split(' -> ')[0]).sort())) return refused('disable-effect-mismatch');
  for (const link of links) if (await lstat(link.split(' -> ')[0]!).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; })) return refused('disable-effect-mismatch');
  return { unit, previous, undo, links };
}
