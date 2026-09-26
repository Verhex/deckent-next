import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectProductDirectory, ManagedFileError, prepareProductDirectory } from '#platform/index.js';

type ProductLayout = Parameters<typeof prepareProductDirectory>[0];

/** Largest approval preview in UTF-8 bytes: far below the event bound and any frame, whatever the script (Astra 2094 R3). */
export const APPROVAL_PREVIEW_MAX_BYTES = 16_384;

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes, never splitting a code point. */
function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0, end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size; end += char.length;
  }
  return text.slice(0, end);
}

/**
 * The preview an approval card shows. A text within the bound is shown whole; a larger one is cut to whole lines (the first line
 * itself cut at a character boundary when it alone is too long) under a first-line marker — the card shows the top lines, so the
 * marker is always visible — naming what is not shown, the sha256 of the whole text and, when kept, the file holding all of it.
 */
export function boundApprovalPreview(text: string, fullAt: string | null = null, maxBytes = APPROVAL_PREVIEW_MAX_BYTES): string {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return text;
  const lines = text.split('\n'), digest = createHash('sha256').update(text).digest('hex');
  const marker = (shown: number, bytes: number) => `[Deckent: preview cut to ${shown} of ${lines.length} lines (${bytes} of ${total} bytes); `
    + `whole text sha256 ${digest}${fullAt ? `; complete at ${fullAt}` : '; not kept'}]`;
  const budget = maxBytes - Buffer.byteLength(marker(lines.length, total), 'utf8') - 1;
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size <= budget) { kept.push(line); bytes += size; continue; }
    if (kept.length === 0) { const part = utf8Prefix(line, Math.max(0, budget - 4)); kept.push(`${part} …`); bytes += Buffer.byteLength(`${part} …`, 'utf8') + 1; }
    break;
  }
  return [marker(kept.length, bytes), ...kept].join('\n');
}

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
