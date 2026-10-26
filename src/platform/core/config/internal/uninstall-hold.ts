import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorRegistry } from '#platform/core/errors/index.js';
/** A durable admission fence, separate from bootstrap/restore. Any entry holds; readers never heal it. */
export const uninstallHoldPath = (dataRoot: string) => join(dataRoot, 'uninstall-hold.json');
export async function assertNoUninstallHold(dataRoot: string): Promise<void> {
  const path = uninstallHoldPath(dataRoot);
  const present = await lstat(path).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
  if (present) throw ErrorRegistry.createError('UNINSTALL_LIFECYCLE_HOLD', { params: { path } });
}
