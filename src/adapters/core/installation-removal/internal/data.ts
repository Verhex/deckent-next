import { createReadStream, type Stats } from 'node:fs';
import { lstat, readFile, realpath, rmdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { EffectTargetError, type EffectTarget, type EffectApplyRequest } from '#engine/index.js';
import { pathWithin as inside } from '#platform/index.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = (code: 'EFFECT_TARGET_REJECTED' | 'EFFECT_TARGET_PRECONDITION'): never => { throw new EffectTargetError(code); };
/** One exact owned file of a purge: the resource owner names it; never a subtree or a path a request supplies. `directory`: its
 * owner's private directory, removed only when nothing else remains in it. */
export interface DataRemovalMember { readonly resourceId: string; readonly path: string; readonly directory: string | null;
  /** The member's path inside its resource as the standard backup set archives it ('' for a file resource). */
  readonly archivePath: string }
/** The verified final backup's exact content of every present member, bound immediately before deletion. */
export interface DataRemovalSnapshot {
  readonly set: string; readonly manifestDigest: string;
  readonly members: readonly { readonly path: string; readonly digest: string; readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number;
    readonly directory?: string | null }[];
}
export async function fileDigest(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}
/** A private, single-link regular file of this user, or null when absent. Anything else is never an owned member. */
export async function memberStat(path: string): Promise<Stats | null> {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077 || await realpath(dirname(path)) !== dirname(path))) refuse('EFFECT_TARGET_REJECTED');
  return info;
}
/** One final effect deletes only the exact owned member files whose bytes the verified final backup holds; unlisted siblings and
 * non-empty parents stay. The plan's version is the members' inode identity; content is bound to the snapshot under custody. */
export class InstallationDataRemovalTarget implements EffectTarget {
  readonly kind = 'installation-data';
  private beforeRemove: (() => Promise<DataRemovalSnapshot>) | undefined;
  constructor(private readonly binding: string, private readonly members: readonly DataRemovalMember[], protectedPaths: readonly string[]) {
    if (process.platform === 'win32' || !process.getuid || members.some(member => !isAbsolute(member.path) || member.path === parse(member.path).root
      || protectedPaths.some(path => inside(member.path, path) || inside(path, member.path)))) refuse('EFFECT_TARGET_REJECTED');
  }
  identity() { return this.binding; }
  /** Only trusted composition under lifecycle custody supplies this callback, never an effect input. */
  prepare(work: () => Promise<DataRemovalSnapshot>) { this.beforeRemove = work; }
  private check(target: { kind: string; id: string }) { if (target.kind !== this.kind || target.id !== 'global-data') refuse('EFFECT_TARGET_REJECTED'); }
  async observe(target: { kind: string; id: string }) {
    this.check(target); const entries = [];
    for (const member of this.members) { const info = await memberStat(member.path); entries.push([member.resourceId, member.path, info?.dev ?? null, info?.ino ?? null]); }
    return { version: entries.every(entry => entry[2] === null) ? null : hash(entries) };
  }
  async apply(request: EffectApplyRequest) {
    this.check(request.target);
    if (request.operation.id !== 'installation.remove-data' || request.operation.version !== 1 || !this.beforeRemove) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    if ((await this.observe(request.target)).version !== request.expectedVersion) refuse('EFFECT_TARGET_PRECONDITION');
    // A failed or unbound snapshot closes no deletion loop; it is safe to report a refusal. After the first unlink, uncertainty is retained.
    const snapshot = await this.beforeRemove();
    const bound = async (member: DataRemovalMember, content: boolean) => {
      const expected = snapshot.members.find(item => item.path === member.path), info = await memberStat(member.path);
      if (!info) return expected ? refuse('EFFECT_TARGET_PRECONDITION') : null;
      if (!expected || info.dev !== expected.dev || info.ino !== expected.ino || info.size !== expected.size || info.mtimeMs !== expected.mtimeMs
        || info.ctimeMs !== expected.ctimeMs || content && await fileDigest(member.path) !== expected.digest) refuse('EFFECT_TARGET_PRECONDITION');
      return expected;
    };
    // Every member is compared with the verified backup before the first unlink: changed bytes are never deleted with an older backup.
    if (snapshot.members.some(item => !this.members.some(member => member.path === item.path))
      || createHash('sha256').update(await readFile(join(snapshot.set, 'MANIFEST.sha256'))).digest('hex') !== snapshot.manifestDigest) refuse('EFFECT_TARGET_PRECONDITION');
    for (const member of this.members) await bound(member, true);
    let started = false;
    try {
      for (const member of this.members) {
        if (!await bound(member, false)) continue;
        started = true; await unlink(member.path);
      }
      for (const directory of new Set(this.members.flatMap(member => member.directory ? [member.directory] : [])))
        await rmdir(directory).catch(error => { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; });
      return { version: null };
    } catch (cause) { if (started) throw new EffectTargetError('EFFECT_TARGET_UNKNOWN', { cause }); throw cause; }
  }
  async lookup(target: { kind: string; id: string }, _key: string) {
    void _key; this.check(target);
    return (await this.observe(target)).version === null ? { status: 'applied' as const, version: null } : null;
  }
}
