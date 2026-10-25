import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { HUB_LIMITS, HubError } from '#domain/index.js';
import { decodeHubBundle, HubClientError } from '#engine/index.js';
/** Explicitly chosen file only. The caller owns the common effect/card authorization before invoking the writer. No overwrite or link following. */
export async function readHubPackageFile(path: string): Promise<Uint8Array> {
  if (process.platform === 'win32' || constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) throw new HubClientError('HUB_FILE_UNSUPPORTED');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o111) !== 0) throw new HubError('HUB_PACKAGE_INVALID');
    if (stat.size > HUB_LIMITS.packageMaxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    const after = await handle.stat();
    if (offset !== bytes.length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new HubError('HUB_DIGEST_MISMATCH');
    decodeHubBundle(bytes); return bytes;
  } finally { await handle.close(); }
}
export async function writeHubPackageFile(path: string, bytes: Uint8Array): Promise<void> {
  decodeHubBundle(bytes);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
