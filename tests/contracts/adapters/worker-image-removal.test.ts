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

it('produces complete fresh daemon/config/retention references without inferring exclusivity from a build receipt, and pins every Docker command', async () => {
  const { nativeWorkerRemovalDriver, observeWorkerRemovalReferences } = await import('#adapters/core/worker-image/index.js');
  const imageId = 'sha256:' + '1'.repeat(64), registry = { daemonId: 'daemon', installationIds: ['temporary', 'other'], revision: 'r1' };
  let unknown = false, foreign = true, drift = false, reads = 0;
  const owner = { inventory: async () => ({ ...registry, revision: drift && ++reads > 1 ? 'r2' : 'r1' }),
    inspect: async (installationId: string) => unknown ? null : { referenced: installationId === 'temporary' || foreign, protected: installationId === 'other', retained: installationId === 'other' } };
  expect(await observeWorkerRemovalReferences(owner, 'daemon', imageId)).toEqual([
    { installationId: 'temporary', protected: false, retained: false }, { installationId: 'other', protected: true, retained: true }]);
  unknown = true; expect(await observeWorkerRemovalReferences(owner, 'daemon', imageId)).toBeNull(); unknown = false;
  drift = true; expect(await observeWorkerRemovalReferences(owner, 'daemon', imageId)).toBeNull(); drift = false;
  const calls: readonly string[][] = []; const mutable = calls as string[][];
  const driver = nativeWorkerRemovalDriver({ executable: 'docker-fixture', endpoint: 'unix:///temporary-only.sock', timeoutMs: 100, outputBytes: 65536,
    receipt: {}, recipeDigest: 'a'.repeat(64), lineageDigest: 'b'.repeat(64), ownedTags: ['owned:tag'], referenceOwner: owner }, async command => {
    mutable.push([...command.args]); expect(command.args.slice(0, 2)).toEqual(['--host', 'unix:///temporary-only.sock']);
    const args = command.args.slice(2);
    const stdout = args[0] === 'info' ? 'daemon\n' : args[0] === 'image' && args[1] === 'ls' ? `${imageId}\n`
      : args[0] === 'image' && args[1] === 'inspect' ? JSON.stringify([{ Id: imageId, RepoTags: ['owned:tag', 'foreign:tag'], RepoDigests: [] }]) : '';
    return { stdout, stderr: '' };
  });
  const resource = { resourceId: 'image', installationId: 'temporary', imageId, daemonId: 'daemon', recipeDigest: 'a'.repeat(64), receiptDigest: 'c'.repeat(64) };
  const observed = await driver.inspect(resource); expect(observed.foreignTags).toEqual(['foreign:tag']);
  expect(observed.references).toContainEqual({ installationId: 'other', protected: true, retained: true });
  await driver.remove(imageId, { force: false, noPrune: true });
  expect(calls.at(-1)).toEqual(['--host', 'unix:///temporary-only.sock', 'image', 'rm', '--no-prune', '--', imageId]);
  foreign = false;
});

it('keeps unknown installations without any daemon command or build-context read when complete reference custody is unavailable', async () => {
  const { observeWorkerRemovalInventory } = await import('#adapters/core/worker-image/index.js');
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'deckent-unknown-image-owner-'));
  try {
    const unowned = join(root, 'unowned'); await writeFile(unowned, 'DO NOT INSPECT', { mode: 0o600 });
    // Reading <regular file>/receipts would throw ENOTDIR; no authoritative owner means no read or daemon command at all.
    expect(await observeWorkerRemovalInventory({ home: unowned, buildersRoot: join(root, 'not-created'), installationId: 'temporary', executable: 'never-run', timeoutMs: 100, outputBytes: 4096 }))
      .toEqual({ targets: [], resources: [] });
    expect(await readdir(root)).toEqual(['unowned']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reports the exact manual removal step from a receipt but probes no daemon without complete lease references', async () => {
  const { observeWorkerRemovalInventory, workerImageManualCommand } = await import('#adapters/core/worker-image/index.js');
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'deckent-image-manual-'));
  try {
    const imageId = 'sha256:' + '3'.repeat(64), home = join(root, 'toolchains'), endpoint = `unix://${join(root, "it's", 'docker.sock')}`;
    await mkdir(join(home, 'receipts'), { recursive: true, mode: 0o700 });
    await writeFile(join(home, 'receipts/r7-20261026.json'), JSON.stringify({ schemaVersion: 3, imageVersion: 'r7-20261026', daemonId: 'daemon', endpoint,
      recipeSha256: 'a'.repeat(64), images: [{ imageId, tag: 'owned:r7' }] }), { mode: 0o600 });
    const observed = await observeWorkerRemovalInventory({ home, buildersRoot: join(root, 'builders'), installationId: 'temporary', executable: 'never-run', timeoutMs: 100, outputBytes: 4096 });
    expect(observed.targets).toEqual([]);
    expect(observed.resources).toEqual([expect.objectContaining({ exclusive: false, present: null, version: null, manualCommand: workerImageManualCommand('never-run', endpoint, imageId) })]);
    // One argv source: the pinned daemon, --no-prune and the exact ID, shell-quoted; never force, prune or a tag.
    expect(observed.resources[0]!.manualCommand).toBe(`never-run --host 'unix://${join(root, "it'\\''s", 'docker.sock')}' image rm --no-prune -- ${imageId}`);
    expect(() => workerImageManualCommand('docker', 'tcp://remote:2375', imageId)).toThrow('WORKER_DAEMON_CHANGED');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('answers references from builder-custody leases only with participation, a private daemon socket and an image born here; a lease cannot be written while removal holds custody', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: lease custody and unix sockets are Linux-only here'); return; }
  const { withWorkerBuilder, workerLeaseReferences, observeWorkerRemovalReferences } = await import('#adapters/core/worker-image/index.js');
  const { writeFile, chmod } = await import('node:fs/promises');
  const { createServer } = await import('node:net');
  const root = await mkdtemp(join(tmpdir(), 'deckent-image-leases-')), server = createServer();
  try {
    const builders = join(root, 'builders'), sockets = join(root, 'run'); await mkdir(builders, { mode: 0o700 }); await mkdir(sockets, { mode: 0o700 });
    const socket = join(sockets, 'docker.sock'), endpoint = `unix://${socket}`; await new Promise<void>(done => server.listen(socket, done));
    const imageId = 'sha256:' + '4'.repeat(64), adopted = 'sha256:' + '5'.repeat(64), daemon = join(builders, createHash('sha256').update('daemon').digest('hex'));
    const custody = (lessee: string, budgetMs = 1000) => ({ root: builders, packageRoot: process.cwd(), daemonId: 'daemon', instanceId: lessee, budgetMs, audit: async () => undefined, lessee });
    const lease = (lessee: string, provenance: string, ids: string[], budgetMs?: number) => withWorkerBuilder(custody(lessee, budgetMs), async run => run.retain({ provenance, images: ids.map(id => ({ imageId: id })) }));
    const owner = workerLeaseReferences(builders, 'daemon', endpoint);
    await lease('temporary', 'built-from-current-sources', [imageId]);
    expect(await owner.inventory()).toBeNull(); // no participation record: pre-lease or invisible users may exist
    await writeFile(join(daemon, 'participation.json'), JSON.stringify({ schemaVersion: 1, daemonId: 'daemon', since: '2020-01-01T00:00:00.000Z' }), { mode: 0o600 });
    expect(await observeWorkerRemovalReferences(owner, 'daemon', imageId)).toEqual([{ installationId: 'temporary', protected: false, retained: false }]);
    await lease('temporary', 'adopted-label-matched', [adopted]);
    expect(await owner.inspect('temporary', adopted)).toBeNull(); // first use here was an adoption: born elsewhere
    await chmod(sockets, 0o755); expect(await owner.inventory()).toBeNull(); await chmod(sockets, 0o700);
    await lease('other', 'adopted-label-matched', [imageId]);
    expect(await observeWorkerRemovalReferences(owner, 'daemon', imageId)).toContainEqual({ installationId: 'other', protected: false, retained: false });
    await writeFile(join(daemon, 'participation.json'), JSON.stringify({ schemaVersion: 1, daemonId: 'daemon', since: '2999-01-01T00:00:00.000Z' }), { mode: 0o600 });
    expect(await owner.inventory()).toBeNull(); // a lease older than participation is a pre-contract record
    // Removal's custody is the same kernel lock: a new user's lease waits and is refused, never written beside a removal.
    await withWorkerBuilder(custody('remover'), async () => {
      await expect(lease('late', 'adopted-label-matched', [imageId], 100)).rejects.toMatchObject({ code: 'WORKER_IMAGE_BUILDING' });
    });
    expect(await readdir(join(daemon, 'leases', createHash('sha256').update(imageId).digest('hex')))).toHaveLength(2);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});
