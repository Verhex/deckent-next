import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { WorkerImageRemovalTarget, workerRemovalGuard, type WorkerRemovalResource, type WorkerRemovalDriver } from './removal.js';
import { nativeWorkerRemovalDriver, workerImageManualCommand, type WorkerReferenceOwner } from './removal-driver.js';
import { workerLeaseReferences } from './references.js';
import limits from './limits.json' with { type: 'json' };
const PRIVATE_PERMISSION_MASK = 0o077;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const schema = z.object({ schemaVersion: z.literal(3), imageVersion: z.string().regex(/^r[1-9][0-9]*-\d{8}$/u), daemonId: z.string().min(1), endpoint: z.string(),
  recipeSha256: z.string(), images: z.array(z.object({ imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u), tag: z.string().nullable().optional() }).passthrough()).nonempty() }).passthrough();
async function read(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & PRIVATE_PERMISSION_MASK || info.size > limits.receiptBytes || await realpath(path) !== path) throw new Error('WORKER_IMAGE_CONTEXT_UNSAFE');
    const bytes = Buffer.alloc(info.size + 1), result = await file.read(bytes, 0, bytes.length, 0), after = await file.stat();
    if (result.bytesRead !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.size !== info.size) throw new Error('WORKER_IMAGE_CONTEXT_UNSAFE');
    return bytes.subarray(0, result.bytesRead);
  } finally { await file.close(); }
}
/** Every image a retained receipt names: its exact manual removal step (bound to the receipt's pinned daemon) is always reported;
 * daemon observation and a removal target exist only when the lease owner proves complete references for that daemon. */
export async function observeWorkerRemovalInventory(input: { home: string; installationId: string; buildersRoot: string; executable: string;
  timeoutMs: number; outputBytes: number; references?: WorkerReferenceOwner }) {
  type Observed = { resource: WorkerRemovalResource; version: string | null; present: boolean | null; exclusive: boolean; manualCommand: string | null };
  const targets: WorkerImageRemovalTarget[] = [], resources = new Map<string, Observed>();
  const drivers = new Map<string, WorkerRemovalDriver>(), duplicate = new Set<string>();
  const directory = join(input.home, 'receipts'), info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; return false as const; });
  if (!info) return { targets, resources: [] };
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & PRIVATE_PERMISSION_MASK || await realpath(directory) !== directory) return { targets, resources: [] };
  const names = [];
  for await (const entry of await opendir(directory)) { if (names.length >= limits.receiptScan) throw new Error('WORKER_IMAGE_CONTEXT_UNSAFE'); names.push(entry.name); }
  for (const name of names.sort()) {
    if (!/^r[1-9][0-9]*-\d{8}\.json$/u.test(name)) continue;
    try {
      const receipt = schema.parse(JSON.parse((await read(join(directory, name))).toString())), receiptDigest = hash(JSON.stringify(receipt));
      const bound = receipt.images.map(image => ({ resourceId: `image.${hash(JSON.stringify(image.imageId))}`, installationId: input.installationId,
        imageId: image.imageId, daemonId: receipt.daemonId, recipeDigest: '', receiptDigest }));
      for (const resource of bound) if (!resources.has(resource.resourceId)) resources.set(resource.resourceId, { resource, version: null, present: null, exclusive: false,
        manualCommand: workerImageManualCommand(input.executable, receipt.endpoint, resource.imageId) });
      // Without complete reference custody even a daemon probe cannot authorize removal; retained build contexts stay unread.
      const references = input.references ?? workerLeaseReferences(input.buildersRoot, receipt.daemonId, receipt.endpoint);
      if (!await references.inventory()) continue;
      const context = join(input.home, 'builds', receipt.imageVersion);
      const recipeDigest = hash(await read(join(context, 'recipe.json'))), lineageDigest = hash(await read(join(context, 'lineage.json')));
      const driver = nativeWorkerRemovalDriver({ executable: input.executable, endpoint: receipt.endpoint, timeoutMs: input.timeoutMs, outputBytes: input.outputBytes,
        receipt, recipeDigest, lineageDigest, ownedTags: receipt.images.flatMap(image => image.tag ? [image.tag] : []), referenceOwner: references });
      for (const resource of bound.map(item => ({ ...item, recipeDigest }))) {
        const observed = await driver.inspect(resource);
        if (drivers.has(resource.resourceId)) duplicate.add(resource.resourceId);
        resources.set(resource.resourceId, { resource, version: hash(JSON.stringify(observed)), present: observed.present, exclusive: !workerRemovalGuard(resource, observed),
          manualCommand: resources.get(resource.resourceId)!.manualCommand });
        drivers.set(resource.resourceId, driver);
      }
    } catch { /* Unknown source, daemon, endpoint, lineage, bound or owner: leave the existing image inventory kept. */ }
  }
  // One kind resolves to one daemon owner; route multiple exact receipt/image resources through that same custody.
  const entries = [...resources.values()], observed = entries.filter(item => drivers.has(item.resource.resourceId)), daemonId = observed[0]?.resource.daemonId;
  if (daemonId && observed.every(item => item.resource.daemonId === daemonId)) {
    const driver: WorkerRemovalDriver = { inspect: resource => drivers.get(resource.resourceId)!.inspect(resource),
      remove: (imageId, options) => drivers.get(observed.find(item => item.resource.imageId === imageId)!.resource.resourceId)!.remove(imageId, options) };
    targets.push(new WorkerImageRemovalTarget(observed.map(item => item.resource), driver, { root: input.buildersRoot,
      packageRoot: fileURLToPath(new URL('../../../../../', import.meta.url)), daemonId, instanceId: randomUUID(), budgetMs: input.timeoutMs, audit: async () => undefined }));
  }
  return { targets, resources: entries.map(item => ({ ...item, exclusive: item.exclusive && targets.length === 1 && !duplicate.has(item.resource.resourceId) })) };
}
