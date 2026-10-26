import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EffectTargetError, type EffectTarget, type EffectApplyRequest } from '#engine/index.js';
import { withWorkerBuilder } from './custody.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/u), imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const receipt = z.object({ schemaVersion: z.literal(3), daemonId: z.string().min(1), recipeSha256: digest,
  lineage: z.literal('listed'), provenance: z.literal('built-from-current-sources'),
  images: z.array(z.object({ imageId }).passthrough()).nonempty(), sources: z.record(digest) }).passthrough();
export interface WorkerRemovalResource {
  readonly resourceId: string; readonly installationId: string; readonly imageId: string;
  readonly daemonId: string; readonly recipeDigest: string; readonly receiptDigest: string;
}
/** Complete owner observations, including every registered installation on the same daemon. Null means not inspected. */
export interface WorkerRemovalObservation {
  readonly daemonId: string; readonly present: boolean | null; readonly receipt: unknown;
  readonly recipeDigest: string | null; readonly lineageDigest: string | null;
  readonly references: readonly { readonly installationId: string; readonly protected: boolean; readonly retained: boolean }[] | null;
  readonly containers: readonly string[] | null; readonly foreignTags: readonly string[] | null;
  readonly revision: string;
}
export interface WorkerRemovalDriver {
  inspect(resource: WorkerRemovalResource): Promise<WorkerRemovalObservation>;
  /** Exact immutable ID, no force and no implicit parent cleanup. */
  remove(imageId: string, options: { readonly force: false; readonly noPrune: true }): Promise<void>;
}
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export function workerRemovalGuard(resource: WorkerRemovalResource, observed: WorkerRemovalObservation): string | null {
  const parsed = receipt.safeParse(observed.receipt);
  if (!imageId.safeParse(resource.imageId).success || observed.daemonId !== resource.daemonId) return 'daemon-changed';
  if (!parsed.success || hash(observed.receipt) !== resource.receiptDigest || parsed.data.daemonId !== resource.daemonId
    || parsed.data.recipeSha256 !== resource.recipeDigest || parsed.data.sources['recipe.json'] !== resource.recipeDigest
    || observed.recipeDigest !== resource.recipeDigest || parsed.data.sources['lineage.json'] !== observed.lineageDigest
    || !parsed.data.images.some(item => item.imageId === resource.imageId)) return 'lineage-unknown';
  if (observed.present === null || observed.references === null || observed.containers === null || observed.foreignTags === null) return 'references-unknown';
  if (observed.containers.length || observed.foreignTags.length) return 'active-or-foreign-reference';
  if (!observed.references.length || observed.references.some(ref => ref.installationId !== resource.installationId || ref.protected || ref.retained)) return 'shared-or-retained';
  return null;
}
/** Removal shares the existing daemon builder custody; receipts, counter and history are never deleted. */
export class WorkerImageRemovalTarget implements EffectTarget {
  readonly kind = 'installation-image';
  constructor(private readonly resources: readonly WorkerRemovalResource[], private readonly driver: WorkerRemovalDriver,
    private readonly custody: Parameters<typeof withWorkerBuilder>[0]) {}
  identity() { return this.custody.daemonId; }
  private resource(target: { kind: string; id: string }) {
    const found = this.resources.find(item => item.resourceId === target.id);
    if (target.kind !== this.kind || !found || found.daemonId !== this.custody.daemonId) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    return found;
  }
  async observe(target: { kind: string; id: string }) { return { version: hash(await this.driver.inspect(this.resource(target))) }; }
  async apply(request: EffectApplyRequest) {
    if (process.platform !== 'linux') throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    const resource = this.resource(request.target);
    if (request.operation.id !== 'installation.remove-image' || request.operation.version !== 1) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    return withWorkerBuilder(this.custody, async () => {
      const current = await this.driver.inspect(resource);
      if (workerRemovalGuard(resource, current)) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
      if (hash(current) !== request.expectedVersion) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
      if (current.present === false) return { version: null };
      // Inspect again immediately before sending: reference/daemon races are refusals, never wider deletion.
      const final = await this.driver.inspect(resource);
      if (workerRemovalGuard(resource, final) || hash(final) !== hash(current)) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
      try {
        await this.driver.remove(resource.imageId, { force: false, noPrune: true });
        const after = await this.driver.inspect(resource);
        if (after.daemonId !== resource.daemonId || after.present !== false) throw new Error('IMAGE_REMOVAL_UNPROVEN');
        return { version: null };
      } catch (cause) { throw new EffectTargetError('EFFECT_TARGET_UNKNOWN', { cause }); }
    });
  }
  async lookup(target: { kind: string; id: string }, idempotencyKey: string) {
    void idempotencyKey;
    const resource = this.resource(target), observed = await this.driver.inspect(resource);
    return observed.daemonId === resource.daemonId && observed.present === false ? { status: 'applied' as const, version: null } : null;
  }
}
