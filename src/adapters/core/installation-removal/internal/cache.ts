import { createHash } from 'node:crypto';
import { lstat, opendir, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import { EffectTargetError, type EffectTarget, type EffectApplyRequest } from '#engine/index.js';
export interface CacheRemovalResource { readonly resourceId: string; readonly path: string; readonly ownershipDigest: string }
export interface CacheRemovalBounds { readonly maxEntries: number; readonly maxDepth: number }
const inside = (parent: string, child: string) => { const path = relative(parent, child); return !path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)); };
const PRIVATE_PERMISSION_MASK = 0o077;
const rejected = (): never => { throw new EffectTargetError('EFFECT_TARGET_REJECTED'); };
/** Disposal is restricted to owner-registered paths. Directory removal is bounded, link-free and never recursive rm. */
export class InstallationCacheRemovalTarget implements EffectTarget {
  readonly kind = 'installation-cache';
  constructor(private readonly binding: string, private readonly resources: readonly CacheRemovalResource[],
    private readonly protectedPaths: readonly string[], private readonly bounds: CacheRemovalBounds,
    private readonly withCustody: <T>(work: () => Promise<T>) => Promise<T>) {
    if (process.platform === 'win32' || !process.getuid) rejected();
    if (!Number.isSafeInteger(bounds.maxEntries) || bounds.maxEntries < 1 || !Number.isSafeInteger(bounds.maxDepth) || bounds.maxDepth < 0) rejected();
  }
  identity() { return this.binding; }
  private resource(target: { kind: string; id: string }) {
    const found = this.resources.find(item => item.resourceId === target.id);
    if (target.kind !== this.kind || !found || !/^[a-f0-9]{64}$/u.test(found.ownershipDigest) || !isAbsolute(found.path)
      || found.path === parse(found.path).root || this.protectedPaths.some(path => inside(found.path, path) || inside(path, found.path))) return rejected();
    return found;
  }
  private async scan(path: string) {
    // Reject symlink ancestors as well as links inside the disposable tree, even for an absent leaf.
    for (let ancestor = dirname(path);;) {
      if (await realpath(ancestor) !== ancestor) rejected();
      const info = await lstat(ancestor);
      if (!info.isDirectory() || (info.mode & 0o022) && !(info.mode & 0o1000)) rejected();
      const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
    }
    const entries: { path: string; directory: boolean; dev: number; ino: number; mtime: number; ctime: number; size: number }[] = [];
    const visit = async (file: string, depth: number): Promise<void> => {
      const info = await lstat(file).catch(error => { if (error.code === 'ENOENT' && file === path) return null; throw error; });
      if (!info) return;
      if (depth > this.bounds.maxDepth || entries.length >= this.bounds.maxEntries || info.isSymbolicLink()
        || info.uid !== process.getuid?.() || (info.mode & PRIVATE_PERMISSION_MASK) || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) rejected();
      entries.push({ path: file, directory: info.isDirectory(), dev: info.dev, ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size });
      if (info.isDirectory()) for await (const child of await opendir(file)) await visit(join(file, child.name), depth + 1);
    };
    await visit(path, 0);
    entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return { entries, version: entries.length ? createHash('sha256').update(JSON.stringify(entries)).digest('hex') : null };
  }
  async observe(target: { kind: string; id: string }) { return { version: (await this.scan(this.resource(target).path)).version }; }
  async apply(request: EffectApplyRequest) {
    if (request.operation.id !== 'installation.remove-cache' || request.operation.version !== 1) rejected();
    const resource = this.resource(request.target);
    return this.withCustody(async () => {
      const scan = await this.scan(resource.path);
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
        return { version: null };
      } catch (cause) { if (started) throw new EffectTargetError('EFFECT_TARGET_UNKNOWN', { cause }); throw cause; }
    });
  }
  async lookup(target: { kind: string; id: string }, idempotencyKey: string) {
    void idempotencyKey;
    return (await this.observe(target)).version === null ? { status: 'applied' as const, version: null } : null;
  }
}
