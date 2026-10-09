import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { productResourcePath, type ProductLayout } from '#platform/index.js';
import { LocalRuntimeSocketError, assertSocketPublicationBudget } from './endpoint.js';

/** One deterministic, short, owner-only directory per installation data root. Full SHA-256 avoids truncation collisions.
 * The Linux peer/custody transport remains the authority; a read never creates or repairs a directory. */
export function runtimeSocketLocation(layout: ProductLayout): string {
  if (process.platform !== 'linux' || !process.getuid) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_UNSUPPORTED');
  const installation = createHash('sha256').update(productResourcePath(layout, 'runtimeSocket')).digest('hex');
  const endpoint = join('/tmp', `dk-${process.getuid()}-${installation}`, 's');
  assertSocketPublicationBudget(endpoint);
  return endpoint;
}
export async function prepareRuntimeSocket(layout: ProductLayout, create = true): Promise<string> {
  const endpoint = runtimeSocketLocation(layout), parent = endpoint.slice(0, endpoint.lastIndexOf('/'));
  if (create) {
    try { await mkdir(parent, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new LocalRuntimeSocketError('LOCAL_RUNTIME_ENDPOINT_UNSAFE', { cause: error }); }
  }
  const stat = await lstat(parent).catch(error => {
    throw new LocalRuntimeSocketError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'LOCAL_RUNTIME_UNAVAILABLE' : 'LOCAL_RUNTIME_ENDPOINT_UNSAFE', { cause: error });
  });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700 || await realpath(parent) !== parent) {
    throw new LocalRuntimeSocketError('LOCAL_RUNTIME_ENDPOINT_UNSAFE');
  }
  const socket = await lstat(endpoint).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (socket && (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== process.getuid!() || (socket.mode & 0o777) !== 0o600)) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_ENDPOINT_UNSAFE');
  return endpoint;
}
