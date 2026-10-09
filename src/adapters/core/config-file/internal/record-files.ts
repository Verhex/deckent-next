import { ErrorRegistry } from '#platform/index.js';
import { constants } from 'node:fs';
import { open, opendir, lstat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { CONFIG_DISCOVERY_BOUNDS, type ConfigDiscoveryLimits } from './discovery.js';

/** Bounded regular-file/directory discovery; symlinks never become selectable records or imports. */
export async function discoverConfigRecordFiles(directory: string, limits: ConfigDiscoveryLimits) {
  const entries: Array<{ path: string; label: string; kind: 'file' | 'directory' }> = [];
  const deadline = Date.now() + limits.timeoutMs, scanLimit = limits.maxEntries * CONFIG_DISCOVERY_BOUNDS.scanFactor;
  let scanned = 0;
  for await (const entry of await opendir(directory)) {
    if (entry.isDirectory() || entry.isFile()) entries.push({ path: join(directory, entry.name), label: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' });
    if (entries.length >= limits.maxEntries || ++scanned >= scanLimit || Date.now() >= deadline) break;
  }
  const parent = dirname(directory);
  return [{ path: directory, label: basename(directory) || directory, kind: 'directory' as const },
    ...(parent === directory ? [] : [{ path: parent, label: '..', kind: 'directory' as const }]), ...entries.sort((a, b) => a.label.localeCompare(b.label))];
}
/** No-follow, bounded read of a selected JSON document. Never follows a link, FIFO or device, and never writes. */
export async function readConfigRecordFile(path: string, maxBytes: number): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw ErrorRegistry.createError('CONFIG_RECORD_INVALID');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) throw ErrorRegistry.createError('CONFIG_RECORD_INVALID');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maxBytes) throw ErrorRegistry.createError('CONFIG_RECORD_INVALID');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
  } finally { await file.close(); }
}
