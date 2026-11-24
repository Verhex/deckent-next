import { lstat, opendir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorRegistry } from '#platform/index.js';
import { refused } from './sealed-capture.js';

/** Account for each name, round new payload to filesystem blocks and charge a block per entry for its metadata. */
export async function reserveSealedCapacity(parent: string, bound: number, sizes: readonly number[]) {
  const { bsize } = await statfs(parent, { bigint: true });
  if (bsize < 1n) throw refused();
  const charge = (size: bigint) => (size + bsize - 1n) / bsize * bsize + bsize;
  async function usage(path: string): Promise<{ reserved: bigint; allocated: bigint }> {
    const info = await lstat(path, { bigint: true });
    let reserved = charge(info.isDirectory() ? 0n : info.size), allocated = info.blocks * 512n;
    if (info.isFile() || info.isSymbolicLink()) return { reserved, allocated };
    if (!info.isDirectory()) throw refused();
    for await (const entry of await opendir(path)) {
      const child = await usage(join(path, entry.name));
      reserved += child.reserved;
      allocated += child.allocated;
    }
    return { reserved, allocated };
  }
  let used = 0n;
  for await (const entry of await opendir(parent)) {
    const { reserved, allocated } = await usage(join(parent, entry.name));
    used += allocated > reserved ? allocated : reserved;
  }
  const needed = sizes.reduce((sum, size) => sum + charge(BigInt(size)), 0n);
  const readable = (bytes: bigint) => bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : bytes.toString();
  if (used + needed > BigInt(bound))
    throw ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED', { params: {
      bound, used: readable(used), needed: readable(needed),
    } });
}
