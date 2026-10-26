import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { privateDirectory } from './build.js';
import type { WorkerReferenceOwner } from './removal-driver.js';
import limits from './limits.json' with { type: 'json' };
const PRIVATE_PERMISSION_MASK = 0o077;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const leaseSchema = z.object({ schemaVersion: z.literal(1), installationId: z.string().min(1), imageId, kind: z.enum(['build', 'adopt']), at: z.string().datetime() }).strict();
const participationSchema = z.object({ schemaVersion: z.literal(1), daemonId: z.string().min(1), since: z.string().datetime() }).strict();
type Lease = z.infer<typeof leaseSchema>;

/** Called only inside the daemon's builder custody (the same lock image removal holds): one lease per installation and image it built
 * or adopted. The first record (the image's birth or first use here) is kept; a repeat use never rewrites it. */
export async function writeWorkerLeases(custody: string, installationId: string, receipt: unknown) {
  // v3 receipts list images; a v2 receipt names one. A lease that cannot be written fails the retain: an unrecorded user is never invisible.
  const parsed = z.object({ provenance: z.string().optional(), imageId: imageId.optional(), images: z.array(z.object({ imageId }).passthrough()).optional() }).passthrough().parse(receipt);
  const images = parsed.images ?? (parsed.imageId ? [{ imageId: parsed.imageId }] : []);
  const root = join(custody, limits.custody.leases);
  await mkdir(root, { recursive: true, mode: 0o700 }); await privateDirectory(root);
  for (const image of images) {
    const directory = join(root, hash(image.imageId));
    await mkdir(directory, { recursive: true, mode: 0o700 }); await privateDirectory(directory);
    const lease: Lease = { schemaVersion: 1, installationId, imageId: image.imageId, kind: parsed.provenance === 'built-from-current-sources' ? 'build' : 'adopt', at: new Date().toISOString() };
    const file = await open(join(directory, `${hash(installationId)}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      .catch(error => { if (error.code === 'EEXIST') return null; throw error; });
    if (file) try { await file.writeFile(JSON.stringify(lease) + '\n'); await file.sync(); } finally { await file.close(); }
  }
}
async function readPrivate(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & PRIVATE_PERMISSION_MASK || info.size > limits.receiptBytes) throw new Error('WORKER_IMAGE_CONTEXT_UNSAFE');
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally { await file.close(); }
}
async function names(directory: string) {
  await privateDirectory(directory); const found: string[] = [];
  for await (const entry of await opendir(directory)) { if (found.length >= limits.receiptScan) throw new Error('WORKER_IMAGE_CONTEXT_UNSAFE'); found.push(entry.name); }
  return found.sort();
}
/** No other OS user can reach a socket whose own directory is private to this user. */
async function privateSocket(endpoint: string) {
  const path = endpoint.slice('unix://'.length), parent = dirname(path);
  const [socket, directory] = await Promise.all([lstat(path), lstat(parent)]);
  return socket.isSocket() && socket.uid === process.getuid?.() && directory.isDirectory() && directory.uid === process.getuid?.()
    && !(directory.mode & PRIVATE_PERMISSION_MASK) && await realpath(parent) === parent;
}
/**
 * Lease-backed reference owner. It answers only when every user of the daemon provably writes leases: a participation record for the
 * daemon, every lease written after it, and a daemon socket private to this OS user. No producer writes the participation record yet:
 * pre-lease versions, installs under another HOME/global root and other OS users can still select a labeled image through the choices
 * path, so their use would be invisible. Until that proof exists the owner answers null and every image is kept.
 */
export function workerLeaseReferences(root: string, daemonId: string, endpoint: string): WorkerReferenceOwner {
  const custody = join(root, hash(daemonId)), leases = join(custody, limits.custody.leases);
  const read = async (): Promise<Lease[] | null> => {
    try {
      const participation = participationSchema.parse(await readPrivate(join(custody, limits.custody.participation)));
      if (participation.daemonId !== daemonId || !await privateSocket(endpoint)) return null;
      const records: Lease[] = [];
      for (const image of await names(leases)) for (const name of await names(join(leases, image))) {
        const lease = leaseSchema.parse(await readPrivate(join(leases, image, name)));
        if (image !== hash(lease.imageId) || name !== `${hash(lease.installationId)}.json` || Date.parse(lease.at) < Date.parse(participation.since)) return null;
        records.push(lease);
      }
      return records;
    } catch { return null; }
  };
  return {
    async inventory() {
      const records = await read();
      return records && { daemonId, installationIds: [...new Set(records.map(lease => lease.installationId))].sort(), revision: hash(JSON.stringify(records)) };
    },
    async inspect(installationId, image) {
      const records = await read(), uses = records?.filter(lease => lease.imageId === image).sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0) ?? [];
      // Born here under the contract: the image's first lease is a build, never an adoption of an image from elsewhere.
      if (!records || uses[0]?.kind !== 'build') return null;
      return { referenced: uses.some(lease => lease.installationId === installationId), protected: false, retained: false };
    },
  };
}
