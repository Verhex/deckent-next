import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { readPinnedFile, removePinnedFile, writePinnedFile } from '#platform/core/utils/index.js';
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
/** R1: the marker is written and removed only through its pinned parent (a linked `installation/` folder is refused, nothing outside is written)
 * and only while the file there is a retired marker of this kind; anything else under that name is kept (typed refusal). */
const marker = (bytes: Buffer) => { try { const body = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  return body['schemaVersion'] === 1 && typeof body['installationId'] === 'string' && typeof body['planDigest'] === 'string' && typeof body['tier'] === 'string'; } catch { return false; } };
export const retireInstallation = (dataRoot: string, body: Readonly<Record<string, string>>) =>
  writePinnedFile(uninstallRetiredPath(dataRoot), Buffer.from(JSON.stringify({ schemaVersion: 1, ...body })), dataRoot, marker);
export async function reopenInstallation(dataRoot: string) {
  const path = uninstallRetiredPath(dataRoot), read = await readPinnedFile(path).catch(() => null);
  if (read && marker(read.bytes)) await removePinnedFile(path, read.identity);
  else if (read !== null || await uninstallRetired(dataRoot)) throw ErrorRegistry.createError('UNINSTALL_RETIRED', { params: { path: dataRoot } });
}
