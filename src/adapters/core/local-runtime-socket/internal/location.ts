import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { productResourcePath, type ProductLayout } from '#platform/index.js';
import { LocalRuntimeSocketError, assertSocketPublicationBudget, resolveSocketParent, socketFileRefusal, socketParentRefusal, unsafeEndpoint } from './endpoint.js';

/** One deterministic, short, owner-only directory per installation data root. Full SHA-256 avoids truncation collisions.
 * The Linux peer/custody transport remains the authority; a read never creates or repairs a directory (only the service start heals its own). */
export function runtimeSocketLocation(layout: ProductLayout): string {
  if (process.platform !== 'linux' || !process.getuid) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_UNSUPPORTED');
  const installation = createHash('sha256').update(productResourcePath(layout, 'runtimeSocket')).digest('hex');
  const endpoint = join('/tmp', `dk-${process.getuid()}-${installation}`, 's');
  assertSocketPublicationBudget(endpoint);
  return endpoint;
}
/** `create` is the service start only; `onHealed` hears (a closed token, never the path) that its own empty directory was re-created 0700. */
export async function prepareRuntimeSocket(layout: ProductLayout, create = true, onHealed?: (reason: 'parent-mode') => void): Promise<string> {
  const endpoint = runtimeSocketLocation(layout), parent = endpoint.slice(0, endpoint.lastIndexOf('/'));
  if (create) {
    try { await mkdir(parent, { mode: 0o700 }); await ownerOnly(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unsafeEndpoint('parent-create', error); if (await healOwnParent(parent)) onHealed?.('parent-mode'); }
  }
  const stat = await lstat(parent).catch(error => {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new LocalRuntimeSocketError('LOCAL_RUNTIME_UNAVAILABLE', { cause: error }) : unsafeEndpoint('parent-stat', error);
  });
  const parentRefused = socketParentRefusal(stat) ?? (await resolveSocketParent(parent) !== parent ? 'parent-realpath' : null);
  if (parentRefused) throw unsafeEndpoint(parentRefused);
  const socket = await lstat(endpoint).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw unsafeEndpoint('socket-stat', error); });
  const socketRefused = socket ? socketFileRefusal(socket) : null;
  if (socketRefused) throw unsafeEndpoint(socketRefused); return endpoint;
}
/** RESTART-HUNT (alpha.56.1): an open-view bwrap mask can leave a vanished runtime directory on the host as 0755. At the service start only, its
 * own empty directory whose only fault is the mode (a real directory of this uid at its own real path) is re-created: rmdir + mkdir, never a path
 * chmod (that follows a link swapped in after the lstat); rmdir refuses a link or a non-empty directory. The caller's checks then run once, unchanged. */
async function healOwnParent(parent: string): Promise<boolean> {
  const stat = await lstat(parent).catch(() => null);
  if (!stat || socketParentRefusal(stat) !== 'parent-mode' || await resolveSocketParent(parent).catch(() => null) !== parent
    || (await readdir(parent).catch(() => null))?.length !== 0) return false;
  try { await rmdir(parent); await mkdir(parent, { mode: 0o700 }); } catch { return false; }
  await ownerOnly(parent); return true;
}
/** A directory this start created is 0700 whatever the umask: set through a descriptor opened without following a link, on a directory of this uid. */
async function ownerOnly(parent: string): Promise<void> {
  const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => null);
  try { const stat = await handle?.stat(); if (stat?.isDirectory() && stat.uid === process.getuid!()) await handle!.chmod(0o700); } finally { await handle?.close(); }
}
