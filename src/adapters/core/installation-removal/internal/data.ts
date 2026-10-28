import type { Stats } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { EffectTargetError, type EffectTarget, type EffectApplyRequest } from '#engine/index.js';
import { pathWithin as inside, boundState, removeBoundMembers, type BoundMember } from '#platform/index.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = (code: 'EFFECT_TARGET_REJECTED' | 'EFFECT_TARGET_PRECONDITION'): never => { throw new EffectTargetError(code); };
/** One exact owned file of a purge: the resource owner names it; never a subtree or a path a request supplies. `directory`: its
 * owner's private directory, removed only when nothing else remains in it. */
export interface DataRemovalMember { readonly resourceId: string; readonly path: string; readonly directory: string | null;
  /** The member's path inside its resource as the standard backup set archives it ('' for a file resource). */
  readonly archivePath: string;
  /** The plan resource deleting it (default `global-data`); `archived`: bound to the uninstall archive (any mode), not the semantic set. */
  readonly target?: string; readonly archived?: boolean;
  /** K1(f): remove only this exact whole line (a bridge line Deckent appended; `before`: the receipt's earlier file digests); the rest stays byte for byte. */
  readonly line?: string; readonly before?: readonly string[] }
/** The verified final backup's exact content of every present member, bound immediately before deletion. `root`: emptied folders go up to it. */
export interface DataRemovalSnapshot { readonly set: string; readonly manifestDigest: string; readonly members: readonly BoundMember[]; readonly root?: string | undefined;
  /** The uninstall archive beside the set: its manifest's digest and the folders it may restore into (none when nothing was archived). */
  readonly archive?: { readonly digest: string; readonly roots: readonly string[] } | undefined }
/** A single-link regular file of this user (private unless `archived`, whose exact bytes the archive holds), or null when absent. */
export async function memberStat(path: string, archived = false): Promise<Stats | null> {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || !archived && info.mode & 0o077 || await realpath(dirname(path)) !== dirname(path))) refuse('EFFECT_TARGET_REJECTED');
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
  private check(target: { kind: string; id: string }) {
    if (target.kind !== this.kind || !this.members.some(member => (member.target ?? 'global-data') === target.id)) refuse('EFFECT_TARGET_REJECTED');
    return this.members.filter(member => (member.target ?? 'global-data') === target.id);
  }
  async observe(target: { kind: string; id: string }) {
    const entries = [];
    for (const member of this.check(target)) { const info = await memberStat(member.path, member.archived); entries.push([member.resourceId, member.path, info?.dev ?? null, info?.ino ?? null]); }
    return { version: entries.every(entry => entry[2] === null) ? null : hash(entries) };
  }
  async apply(request: EffectApplyRequest) {
    const members = this.check(request.target);
    if (request.operation.id !== 'installation.remove-data' || request.operation.version !== 1 || !this.beforeRemove) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    if ((await this.observe(request.target)).version !== request.expectedVersion) refuse('EFFECT_TARGET_PRECONDITION');
    // A failed or unbound snapshot closes no deletion loop; it is safe to report a refusal. After the first removal, uncertainty is retained.
    const snapshot = await this.beforeRemove(), bound = members.map(member => snapshot.members.find(item => item.path === member.path));
    // Every member is compared with the verified backup before the first removal: changed bytes are never deleted with an older backup.
    if (snapshot.members.some(item => !this.members.some(member => member.path === item.path))
      || createHash('sha256').update(await readFile(join(snapshot.set, 'MANIFEST.sha256'))).digest('hex') !== snapshot.manifestDigest) refuse('EFFECT_TARGET_PRECONDITION');
    for (const [index, member] of members.entries()) { const state = bound[index] ? await boundState(bound[index]) : await memberStat(member.path, member.archived).then(info => info ? 'changed' : 'absent');
      if (state !== 'bound' && (state !== 'absent' || bound[index])) refuse('EFFECT_TARGET_PRECONDITION'); }
    try { await removeBoundMembers(bound.filter(item => !!item), snapshot.root); return { version: null }; }
    catch (cause) { throw new EffectTargetError('EFFECT_TARGET_UNKNOWN', { cause }); }
  }
  async lookup(target: { kind: string; id: string }, _key: string) {
    void _key; this.check(target);
    return (await this.observe(target)).version === null ? { status: 'applied' as const, version: null } : null;
  }
}
