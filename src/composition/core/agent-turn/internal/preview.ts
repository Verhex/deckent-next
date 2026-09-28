import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectProductDirectory, ManagedFileError, prepareProductDirectory } from '#platform/index.js';

type ProductLayout = Parameters<typeof prepareProductDirectory>[0];

/**
 * The whole text of a cut preview, kept owner-only (0600, exclusive, no-follow) while its approval is pending so the owner can review
 * all of the change. Not redacted: it must be exactly the change being approved, and it mirrors workspace content the owner already
 * holds. Removed when the approval settles; left-overs are swept at service start (no approval is pending across a restart).
 */
export async function keepFullPreview(layout: ProductLayout, approvalId: string, text: string): Promise<string> {
  const path = join(await prepareProductDirectory(layout, 'approvalPreviews'), `${createHash('sha256').update(approvalId).digest('hex')}.txt`);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  return path;
}
export const dropFullPreview = (path: string) => unlink(path).catch(() => undefined);

/** Service start: every kept preview belongs to an approval that can no longer be pending. Returns how many were removed. */
export async function sweepFullPreviews(layout: ProductLayout): Promise<number> {
  let directory: string;
  try { directory = await inspectProductDirectory(layout, 'approvalPreviews'); }
  catch (error) { if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return 0; throw error; }
  let removed = 0;
  for (const name of await readdir(directory)) if (/^[0-9a-f]{64}\.txt$/.test(name)) { await unlink(join(directory, name)); removed++; }
  return removed;
}
