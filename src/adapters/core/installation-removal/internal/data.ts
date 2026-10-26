import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EffectTargetError, type EffectTarget, type EffectApplyRequest } from '#engine/index.js';
import { InstallationCacheRemovalTarget, type CacheRemovalBounds, type CacheRemovalResource } from './cache.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** One final effect owns the explicit portable resource set. Policy, identity and integrity are removed last, after native stores close.
 * Its precondition is the owned set's inode identity; the latest bytes are backed up AND verified under custody immediately before deletion. */
export class InstallationDataRemovalTarget implements EffectTarget {
  readonly kind = 'installation-data';
  private readonly files: InstallationCacheRemovalTarget;
  private beforeRemove: (() => Promise<void>) | undefined;
  constructor(private readonly binding: string, private readonly resources: readonly CacheRemovalResource[], protectedPaths: readonly string[], bounds: CacheRemovalBounds) {
    this.files = new InstallationCacheRemovalTarget(binding, resources, protectedPaths, bounds, work => work(), { kind: this.kind, id: 'installation.remove-data' });
  }
  identity() { return this.binding; }
  /** Only trusted composition under lifecycle custody supplies this callback, never an effect input. */
  prepare(work: () => Promise<void>) { this.beforeRemove = work; }
  private check(target: { kind: string; id: string }) {
    if (target.kind !== this.kind || target.id !== 'global-data') throw new EffectTargetError('EFFECT_TARGET_REJECTED');
  }
  async observe(target: { kind: string; id: string }) {
    this.check(target); const entries = [];
    for (const resource of this.resources) {
      await this.files.observe({ kind: this.kind, id: resource.resourceId });
      const info = await lstat(resource.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      entries.push([resource.resourceId, resource.path, info?.dev ?? null, info?.ino ?? null]);
    }
    return { version: entries.every(entry => entry[2] === null) ? null : hash(entries) };
  }
  async apply(request: EffectApplyRequest) {
    this.check(request.target);
    if (request.operation.id !== 'installation.remove-data' || request.operation.version !== 1 || !this.beforeRemove) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    if ((await this.observe(request.target)).version !== request.expectedVersion) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
    // A failed snapshot closes no deletion loop; it is safe to report a refusal. After the first unlink, uncertainty is retained.
    await this.beforeRemove();
    let started = false;
    try {
      for (const resource of this.resources) {
        const target = { kind: this.kind, id: resource.resourceId }, version = (await this.files.observe(target)).version;
        if (version !== null) { started = true; await this.files.apply({ ...request, target, expectedVersion: version }); }
      }
      return { version: null };
    } catch (cause) { if (started) throw new EffectTargetError('EFFECT_TARGET_UNKNOWN', { cause }); throw cause; }
  }
  async lookup(target: { kind: string; id: string }, _key: string) {
    void _key; this.check(target);
    return (await this.observe(target)).version === null ? { status: 'applied' as const, version: null } : null;
  }
}
