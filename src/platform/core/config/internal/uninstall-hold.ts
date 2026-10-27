import { lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeTextAtomic } from '#platform/core/utils/index.js';
import { ErrorRegistry } from '#platform/core/errors/index.js';
/** A durable admission fence, separate from bootstrap/restore. Any entry holds; readers never heal it. */
export const uninstallHoldPath = (dataRoot: string) => join(dataRoot, 'uninstall-hold.json');
export async function assertNoUninstallHold(dataRoot: string): Promise<void> {
  const path = uninstallHoldPath(dataRoot);
  const present = await lstat(path).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
  if (present) throw ErrorRegistry.createError('UNINSTALL_LIFECYCLE_HOLD', { params: { path } });
}
/** §5.4 (owner 2026-10-27): a folder whose installation was removed keeping its data. The service does not start while it exists; the
 * person's own terminal reopens the folder (one card) and only that removes it. */
export const uninstallRetiredPath = (dataRoot: string) => join(dataRoot, 'installation', 'retired.json');
export const uninstallRetired = (dataRoot: string) => lstat(uninstallRetiredPath(dataRoot)).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
export async function assertNotRetired(dataRoot: string) { if (await uninstallRetired(dataRoot)) throw ErrorRegistry.createError('UNINSTALL_RETIRED', { params: { path: dataRoot } }); }
export async function retireInstallation(dataRoot: string, body: Readonly<Record<string, string>>) {
  await mkdir(dirname(uninstallRetiredPath(dataRoot)), { recursive: true, mode: 0o700 }); await writeTextAtomic(uninstallRetiredPath(dataRoot), JSON.stringify({ schemaVersion: 1, ...body }));
}
export const reopenInstallation = (dataRoot: string) => unlink(uninstallRetiredPath(dataRoot)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
