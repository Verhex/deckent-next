import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { productResourcePath, type ProductLayout } from '#platform/index.js';
import { LocalRuntimeSocketError, assertSocketPublicationBudget, resolveSocketParent, socketFileRefusal, socketParentRefusal, unsafeEndpoint } from './endpoint.js';

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
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unsafeEndpoint('parent-create', error); }
  }
  const stat = await lstat(parent).catch(error => {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new LocalRuntimeSocketError('LOCAL_RUNTIME_UNAVAILABLE', { cause: error }) : unsafeEndpoint('parent-stat', error);
  });
  const parentRefused = socketParentRefusal(stat);
  if (parentRefused) throw unsafeEndpoint(parentRefused);
  if (await resolveSocketParent(parent) !== parent) throw unsafeEndpoint('parent-realpath');
  const socket = await lstat(endpoint).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw unsafeEndpoint('socket-stat', error); });
  const socketRefused = socket ? socketFileRefusal(socket) : null;
  if (socketRefused) throw unsafeEndpoint(socketRefused);
  return endpoint;
}
