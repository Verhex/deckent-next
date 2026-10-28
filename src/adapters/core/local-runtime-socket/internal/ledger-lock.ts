import { closeSync, fstatSync } from 'node:fs';
import { readPinnedFile, removePinnedFile } from '#platform/index.js';
import { createRequire } from 'node:module';
import { isAbsolute, normalize } from 'node:path';
import { LocalRuntimeSocketError } from './endpoint.js';

interface LockModule { lockFile(path: string): number | null }
/** A held ledger custody; `release` is idempotent. `remove` (a completed project-folder purge) unlinks the lock file only while the path is
 * still exactly the file this custody holds (same device and inode) and it is empty (R2: bytes in it are someone's), never another file; then releases. */
export interface LedgerLock { readonly path: string; release(): void; remove(): Promise<void> }

/** Owner 2026-09-28 (LEDGER-SINGLETON): one runtime service per ledger. The custody is an exclusive kernel `flock` on the
 * ledger's private companion file (`<ledger>-lock`), opened close-on-exec by the native adapter. It does not depend on the
 * configurable endpoint or on the network namespace, and the kernel frees it when the holder dies. Held by another open file
 * description (another service, in this process or any other) → `LOCAL_RUNTIME_ALREADY_RUNNING`, naming neither the other
 * endpoint nor its process; an unsafe file (link, other owner, mode, second link, swapped path) → `LOCAL_RUNTIME_ENDPOINT_UNSAFE`. */
export function acquireLedgerLock(path: string): LedgerLock {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0')) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_OPTIONS');
  let native: LockModule;
  try { native = createRequire(import.meta.url)('../native/build/Release/peer_credentials.node') as LockModule; }
  catch (error) { throw new LocalRuntimeSocketError('LOCAL_RUNTIME_NATIVE_UNAVAILABLE', { cause: error }); }
  let fd: number | null;
  try { fd = native.lockFile(path); }
  catch (error) {
    const unsafe = (error as { code?: unknown }).code === 'LOCAL_PEER_LOCK_UNSAFE';
    throw new LocalRuntimeSocketError(unsafe ? 'LOCAL_RUNTIME_ENDPOINT_UNSAFE' : 'LOCAL_RUNTIME_TRANSPORT', { cause: error });
  }
  if (fd === null) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_ALREADY_RUNNING');
  let held: number | null = fd;
  const release = () => { if (held === null) return; const closing = held; held = null; closeSync(closing); };
  return Object.freeze({ path, release, async remove() { if (held === null) return; const own = fstatSync(held), now = await readPinnedFile(path).catch(() => null);
    if (now && now.identity.dev === own.dev && now.identity.ino === own.ino && now.identity.size === 0) await removePinnedFile(path, now.identity).catch(() => undefined); release(); } });
}
