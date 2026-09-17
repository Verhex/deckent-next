import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { productResourcePath, type ProductLayout, type ProductResource } from '#platform/core/host/index.js';

export class ManagedFileError extends Error {
  constructor(readonly code: 'MANAGED_FILE_UNSUPPORTED' | 'MANAGED_FILE_UNSAFE' | 'MANAGED_FILE_OUTSIDE_ROOT' | 'MANAGED_FILE_MISSING') {
    super(code); this.name = 'ManagedFileError';
  }
}
function missing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
async function inspect(path: string) {
  try { return await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
}
function privateFile(stat: Stats, uid: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new ManagedFileError('MANAGED_FILE_UNSAFE');
  }
}
/** Trusted-host preflight. This is NOT openat custody or a sandbox against concurrent same-UID workers.
 * Composition must keep this tree outside the writable worker sandbox; no permissions are silently repaired.
 */
export async function prepareProductFile(layout: ProductLayout, resource: ProductResource, companions: readonly string[] = []): Promise<string> {
  const path = await prepareLocation(layout, resource, false);
  const uid = process.getuid!();
  for (const suffix of companions) {
    if (!/^-[a-z]+$/.test(suffix)) throw new ManagedFileError('MANAGED_FILE_UNSAFE');
    const stat = await inspect(path + suffix); if (stat) privateFile(stat, uid);
  }
  const existing = await inspect(path); if (existing) privateFile(existing, uid);
  let handle;
  try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  }
  try {
    const opened = await handle.stat(); privateFile(opened, uid);
    const linked = await lstat(path);
    if (linked.ino !== opened.ino || linked.dev !== opened.dev || linked.isSymbolicLink()) throw new ManagedFileError('MANAGED_FILE_UNSAFE');
  } finally { await handle.close(); }
  return path;
}

async function prepareLocation(layout: ProductLayout, resource: ProductResource, asDirectory: boolean, create = true): Promise<string> {
  if (process.platform === 'win32' || layout.platform !== 'posix' || !process.getuid) throw new ManagedFileError('MANAGED_FILE_UNSUPPORTED');
  const uid = process.getuid(); const root = resolve(layout.root); const path = productResourcePath(layout, resource);
  if (root === parse(root).root) throw new ManagedFileError('MANAGED_FILE_UNSAFE');
  const within = relative(root, path);
  if (!within || within.startsWith(`..${sep}`) || within === '..' || resolve(path) !== path) throw new ManagedFileError('MANAGED_FILE_OUTSIDE_ROOT');
  const directory = asDirectory ? path : dirname(path);
  // Validate existing ancestors before creating anything through them; reject symlink ancestors as well.
  let cursor = parse(directory).root;
  for (const segment of directory.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    let stat = await inspect(cursor);
    if (!stat) {
      if (!create) throw new ManagedFileError('MANAGED_FILE_MISSING');
      try { await mkdir(cursor, { mode: 0o700 }); } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      stat = await lstat(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ManagedFileError('MANAGED_FILE_UNSAFE');
    if ((cursor === root || cursor.startsWith(root + sep)) && (stat.uid !== uid || (stat.mode & 0o022) !== 0)) {
      throw new ManagedFileError('MANAGED_FILE_UNSAFE');
    }
  }
  if (await realpath(root) !== root || await realpath(directory) !== directory) throw new ManagedFileError('MANAGED_FILE_UNSAFE');
  return path;
}

export async function prepareProductDirectory(layout: ProductLayout, resource: ProductResource): Promise<string> {
  return prepareLocation(layout, resource, true);
}

/** Validate an existing managed file without creating directories/files or repairing permissions.
 * Same trusted-host preflight limitation as prepareProductFile; the returned path is not an open lease.
 */
export async function inspectProductFile(layout: ProductLayout, resource: ProductResource, companions: readonly string[] = []): Promise<string> {
  const path = await prepareLocation(layout, resource, false, false);
  const uid = process.getuid!();
  for (const suffix of companions) {
    if (!/^-[a-z]+$/.test(suffix)) throw new ManagedFileError('MANAGED_FILE_UNSAFE');
    const companion = await inspect(path + suffix); if (companion) privateFile(companion, uid);
  }
  const existing = await inspect(path);
  if (!existing) throw new ManagedFileError('MANAGED_FILE_MISSING');
  privateFile(existing, uid);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat(); privateFile(opened, uid);
    const linked = await lstat(path);
    if (linked.ino !== opened.ino || linked.dev !== opened.dev || linked.isSymbolicLink()) throw new ManagedFileError('MANAGED_FILE_UNSAFE');
  } finally { await handle.close(); }
  return path;
}
