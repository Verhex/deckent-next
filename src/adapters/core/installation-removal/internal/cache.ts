import { createHash } from 'node:crypto';
import { lstat, opendir, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import { EffectTargetError, type EffectTarget, type EffectApplyRequest } from '#engine/index.js';
/** `members`: the resource owner's naming, one anchored pattern per level below `path`; a last-level match is one owned tree. */
export interface CacheRemovalResource { readonly resourceId: string; readonly path: string; readonly ownershipDigest: string; readonly members: readonly string[] }
export interface CacheRemovalBounds { readonly maxEntries: number; readonly maxDepth: number }
const inside = (parent: string, child: string) => { const path = relative(parent, child); return !path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)); };
const PRIVATE_PERMISSION_MASK = 0o077;
const rejected = (): never => { throw new EffectTargetError('EFFECT_TARGET_REJECTED'); };
/** Disposal is restricted to the owner's named members below a registered path; unlisted entries and non-empty parents stay.
 * Directory removal is bounded, link-free and never recursive rm. */
export class InstallationCacheRemovalTarget implements EffectTarget {
  readonly kind: string;
  constructor(private readonly binding: string, private readonly resources: readonly CacheRemovalResource[],
    private readonly protectedPaths: readonly string[], private readonly bounds: CacheRemovalBounds,
    private readonly withCustody: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly operation = { kind: 'installation-cache', id: 'installation.remove-cache' }) {
    this.kind = operation.kind;
    if (process.platform === 'win32' || !process.getuid) rejected();
    if (!Number.isSafeInteger(bounds.maxEntries) || bounds.maxEntries < 1 || !Number.isSafeInteger(bounds.maxDepth) || bounds.maxDepth < 0) rejected();
  }
  identity() { return this.binding; }
  private resource(target: { kind: string; id: string }) {
    const found = this.resources.find(item => item.resourceId === target.id);
    if (target.kind !== this.kind || !found || !/^[a-f0-9]{64}$/u.test(found.ownershipDigest) || !isAbsolute(found.path)
      || found.path === parse(found.path).root || !found.members.length || found.members.some(pattern => !/^\^.*\$$/u.test(pattern))
      || this.protectedPaths.some(path => inside(found.path, path) || inside(path, found.path))) return rejected();
    return found;
  }
  private async scan(resource: CacheRemovalResource) {
    const path = resource.path;
    // Reject symlink ancestors as well as links inside the disposable tree, even for an absent leaf.
    for (let ancestor = dirname(path);;) {
      if (await realpath(ancestor) !== ancestor) rejected();
      const info = await lstat(ancestor);
      if (!info.isDirectory() || (info.mode & 0o022) && !(info.mode & 0o1000)) rejected();
      const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
    }
    const entries: { path: string; directory: boolean; dev: number; ino: number; mtime: number; ctime: number; size: number }[] = [];
    const members: string[] = [], unlisted: string[] = [], parents: string[] = [];
    const check = (info: import('node:fs').Stats, depth: number) => {
      if (depth > this.bounds.maxDepth || entries.length + unlisted.length >= this.bounds.maxEntries || info.isSymbolicLink()
        || info.uid !== process.getuid?.() || (info.mode & PRIVATE_PERMISSION_MASK) || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) rejected();
    };
    const visit = async (file: string, depth: number): Promise<void> => {
      const info = await lstat(file); check(info, depth);
      entries.push({ path: file, directory: info.isDirectory(), dev: info.dev, ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size });
      if (info.isDirectory()) for await (const child of await opendir(file)) await visit(join(file, child.name), depth + 1);
    };
    // Only the owner's named members are claimed; anything else (a same-user stray file, another product's record) is kept and reported.
    const level = async (directory: string, depth: number): Promise<void> => {
      const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT' && directory === path) return null; throw error; });
      if (!info) return;
      check(info, depth); if (!info.isDirectory()) rejected();
      if (depth) parents.push(directory);
      for await (const child of await opendir(directory)) {
        const file = join(directory, child.name);
        if (!new RegExp(resource.members[depth]!, 'u').test(child.name)) { if (entries.length + unlisted.length >= this.bounds.maxEntries) rejected(); unlisted.push(file); }
        else if (depth === resource.members.length - 1) { members.push(file); await visit(file, depth + 1); }
        else await level(file, depth + 1);
      }
    };
    await level(path, 0);
    entries.sort((a, b) => a.path.localeCompare(b.path, 'en')); members.sort(); unlisted.sort();
    return { entries, members, unlisted, parents: [...parents, path], version: entries.length ? createHash('sha256').update(JSON.stringify(entries)).digest('hex') : null };
  }
  /** Owner-named members, the unlisted entries a removal keeps, and the members' exact version (null when no member remains). */
  async inspect(target: { kind: string; id: string }) { const { members, unlisted, version } = await this.scan(this.resource(target)); return { members, unlisted, version }; }
  async observe(target: { kind: string; id: string }) { return { version: (await this.scan(this.resource(target))).version }; }
  async apply(request: EffectApplyRequest) {
    if (request.operation.id !== this.operation.id || request.operation.version !== 1) rejected();
    const resource = this.resource(request.target);
    return this.withCustody(async () => {
      const scan = await this.scan(resource);
      if (scan.version !== request.expectedVersion) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
      let started = false;
      try {
        for (const entry of scan.entries.sort((a, b) => b.path.length - a.path.length)) {
          const now = await lstat(entry.path);
          if (now.dev !== entry.dev || now.ino !== entry.ino || now.isSymbolicLink()) rejected();
          if (!entry.directory && (now.size !== entry.size || now.mtimeMs !== entry.mtime || now.ctimeMs !== entry.ctime)) rejected();
          started = true;
          if (entry.directory) await rmdir(entry.path); else await unlink(entry.path);
        }
        // A parent that still holds an unlisted entry is kept; it was never a member.
        for (const parent of scan.parents.sort((a, b) => b.length - a.length)) await rmdir(parent).catch(error => { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; });
        return { version: null };
      } catch (cause) { if (started) throw new EffectTargetError('EFFECT_TARGET_UNKNOWN', { cause }); throw cause; }
    });
  }
  async lookup(target: { kind: string; id: string }, idempotencyKey: string) {
    void idempotencyKey;
    return (await this.observe(target)).version === null ? { status: 'applied' as const, version: null } : null;
  }
}
