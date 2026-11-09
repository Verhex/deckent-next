import { setTimeout as delay } from 'node:timers/promises';
import { acquireLedgerLock, type LedgerLock } from '#adapters/core/local-runtime-socket/index.js';

export type ExclusiveFileLock = LedgerLock;
/** X11 (KG7 F5) [floor]: the one exclusive file lock, an exclusive kernel `flock` on a private companion file. The kernel frees it when its holder
 * dies; a live holder is never displaced. Polls every `pollMs` until `waitMs` (0 = one try); `null` = still held then. An unsafe file or a
 * missing native addon throws (`acquireLedgerLock` codes). Release never unlinks: another waiter must not lock a different inode. */
export async function withExclusiveFileLock(path: string, bounds: Readonly<{ waitMs: number; pollMs: number; signal?: AbortSignal | undefined }>): Promise<ExclusiveFileLock | null> {
  const deadline = performance.now() + bounds.waitMs;
  for (;;) {
    bounds.signal?.throwIfAborted();
    try { return acquireLedgerLock(path); }
    catch (error) { if ((error as { code?: unknown }).code !== 'LOCAL_RUNTIME_ALREADY_RUNNING') throw error; }
    if (performance.now() >= deadline) return null;
    await delay(bounds.pollMs, undefined, bounds.signal ? { signal: bounds.signal } : undefined);
  }
}
