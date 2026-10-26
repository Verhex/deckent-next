import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkerImageRemovalTarget, workerRemovalGuard, type WorkerRemovalObservation } from '#adapters/core/worker-image/index.js';

it('removes only an exclusive source-proven exact image under builder custody and preserves foreign/protected/retained/unknown/raced references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-image-removal-'));
  try {
    const builders = join(root, 'builders'); await mkdir(builders, { mode: 0o700 });
    const imageId = 'sha256:' + '1'.repeat(64), recipeDigest = 'a'.repeat(64), lineageDigest = 'b'.repeat(64);
    const receipt = { schemaVersion: 3, daemonId: 'daemon', recipeSha256: recipeDigest, lineage: 'listed', provenance: 'built-from-current-sources',
      images: [{ imageId }], sources: { 'recipe.json': recipeDigest, 'lineage.json': lineageDigest } };
    const resource = { resourceId: 'image', installationId: 'temporary', imageId, daemonId: 'daemon', recipeDigest,
      receiptDigest: createHash('sha256').update(JSON.stringify(receipt)).digest('hex') };
    const original: WorkerRemovalObservation = { daemonId: 'daemon', present: true, receipt, recipeDigest, lineageDigest,
      references: [{ installationId: 'temporary', protected: false, retained: false }], containers: [], foreignTags: [], revision: 'v1' };
    const removed: string[] = []; let current = original, reads = 0, race = false;
    const target = new WorkerImageRemovalTarget([resource], {
      async inspect() { reads++; return race && reads > 2 ? { ...current, daemonId: 'changed-daemon' } : current; },
      async remove(id, options) { expect(options).toEqual({ force: false, noPrune: true }); removed.push(id); current = { ...current, present: false }; },
    }, { root: builders, packageRoot: process.cwd(), daemonId: 'daemon', instanceId: 'fixture', budgetMs: 1000, audit: async () => undefined });
    const ref = { kind: target.kind, id: 'image' };
    const observe = await target.observe(ref); expect(await readdir(builders)).toEqual([]);
    const request = { target: ref, operation: { id: 'installation.remove-image', version: 1 }, idempotencyKey: 'key', expectedVersion: observe.version, input: null };
    if (process.platform !== 'linux') {
      await expect(target.apply(request)).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
      expect(removed).toEqual([]); console.info('verify-not-run: worker removal positive requires Linux builder custody'); return;
    }
    for (const change of [
      { references: [{ installationId: 'other', protected: false, retained: false }] },
      { references: [{ installationId: 'temporary', protected: true, retained: false }] },
      { references: [{ installationId: 'temporary', protected: false, retained: true }] },
      { references: null }, { containers: ['active-container'] }, { foreignTags: ['foreign:tag'] },
      { receipt: { ...receipt, provenance: 'adopted-label-matched' } }, { daemonId: 'changed-daemon' },
    ]) {
      current = { ...original, ...change };
      expect(workerRemovalGuard(resource, current)).not.toBeNull();
      await expect(target.apply(request)).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
    }
    expect(removed).toEqual([]);
    current = original; reads = 0; race = true;
    request.expectedVersion = (await target.observe(ref)).version;
    await expect(target.apply(request)).rejects.toMatchObject({ code: 'EFFECT_TARGET_PRECONDITION' }); expect(removed).toEqual([]);
    race = false; current = original; await target.apply(request);
    expect(removed).toEqual([imageId]); expect(await target.lookup(ref, 'key')).toEqual({ status: 'applied', version: null });
    const daemon = join(builders, createHash('sha256').update('daemon').digest('hex'));
    expect(await readdir(daemon)).toContain('receipts');
  } finally { await rm(root, { recursive: true, force: true }); }
});
