import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { WorkerImageRemovalTarget, workerRemovalGuard, type WorkerRemovalResource, type WorkerRemovalDriver } from './removal.js';
import { nativeWorkerRemovalDriver, type WorkerReferenceOwner } from './removal-driver.js';
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
/** No historical registry can be reconstructed from one installation's receipts. Unregistered/unknown reference custody always keeps images. */
const unknownReferences: WorkerReferenceOwner = { inventory: async () => null, inspect: async () => null };
export async function observeWorkerRemovalInventory(input: { home: string; installationId: string; buildersRoot: string; executable: string;
  timeoutMs: number; outputBytes: number; references?: WorkerReferenceOwner }) {
  const targets: WorkerImageRemovalTarget[] = [], resources = new Map<string, { resource: WorkerRemovalResource; version: string; present: boolean | null; exclusive: boolean }>();
  const drivers = new Map<string, WorkerRemovalDriver>(), duplicate = new Set<string>();
  // Without complete reference custody, even a daemon probe cannot authorize removal. Avoid scanning unrelated retained contexts.
  if (!await (input.references ?? unknownReferences).inventory()) return { targets, resources: [] };
  const directory = join(input.home, 'receipts'), info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return { targets, resources: [...resources.values()] };
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & PRIVATE_PERMISSION_MASK || await realpath(directory) !== directory) return { targets, resources: [] };
  const names = [];
  for await (const entry of await opendir(directory)) { if (names.length >= limits.receiptScan) throw new Error('WORKER_IMAGE_CONTEXT_UNSAFE'); names.push(entry.name); }
  for (const name of names.sort()) {
    if (!/^r[1-9][0-9]*-\d{8}\.json$/u.test(name)) continue;
    try {
      const receipt = schema.parse(JSON.parse((await read(join(directory, name))).toString())), context = join(input.home, 'builds', receipt.imageVersion);
      const recipeDigest = hash(await read(join(context, 'recipe.json'))), lineageDigest = hash(await read(join(context, 'lineage.json')));
      const driver = nativeWorkerRemovalDriver({ executable: input.executable, endpoint: receipt.endpoint, timeoutMs: input.timeoutMs, outputBytes: input.outputBytes,
        receipt, recipeDigest, lineageDigest, ownedTags: receipt.images.flatMap(image => image.tag ? [image.tag] : []), referenceOwner: input.references ?? unknownReferences });
      const bound = receipt.images.map(image => ({ resourceId: `image.${hash(JSON.stringify(image.imageId))}`, installationId: input.installationId,
        imageId: image.imageId, daemonId: receipt.daemonId, recipeDigest, receiptDigest: hash(JSON.stringify(receipt)) }));
      for (const resource of bound) {
        const observed = await driver.inspect(resource);
        if (resources.has(resource.resourceId)) duplicate.add(resource.resourceId);
        resources.set(resource.resourceId, { resource, version: hash(JSON.stringify(observed)), present: observed.present, exclusive: !workerRemovalGuard(resource, observed) });
        drivers.set(resource.resourceId, driver);
      }
    } catch { /* Unknown source, daemon, endpoint, lineage, bound or owner: leave the existing image inventory kept. */ }
  }
  // One kind resolves to one daemon owner; route multiple exact receipt/image resources through that same custody.
  const entries = [...resources.values()], daemonId = entries[0]?.resource.daemonId;
  if (daemonId && entries.every(item => item.resource.daemonId === daemonId)) {
    const driver: WorkerRemovalDriver = { inspect: resource => drivers.get(resource.resourceId)!.inspect(resource),
      remove: (imageId, options) => drivers.get(entries.find(item => item.resource.imageId === imageId)!.resource.resourceId)!.remove(imageId, options) };
    targets.push(new WorkerImageRemovalTarget(entries.map(item => item.resource), driver, { root: input.buildersRoot,
      packageRoot: fileURLToPath(new URL('../../../../../', import.meta.url)), daemonId, instanceId: randomUUID(), budgetMs: input.timeoutMs, audit: async () => undefined }));
  }
  return { targets, resources: entries.map(item => ({ ...item, exclusive: item.exclusive && targets.length === 1 && !duplicate.has(item.resource.resourceId) })) };
}
