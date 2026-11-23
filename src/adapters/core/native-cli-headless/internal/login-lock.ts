import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withExclusiveFileLock, type ExclusiveFileLock } from '#adapters/core/file-lock/index.js';
import { probeProcessExistence, readPinnedFile } from '#platform/index.js';
import { refuse } from './contract.js';
import type { HeadlessEntry } from './env.js';

const LOCK_DIR = 'login-locks';
type Holder = Readonly<{ schemaVersion?: 2; pid: number; atMs: number; token: string }>;
type LegacyBusy = 'legacy-unverified' | 'legacy-process' | 'legacy-process-unverified';
async function cliLockHeld(configDir: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) if (await lstat(join(configDir, name)).then(() => true, error => {
    if ((error as { code?: unknown }).code === 'ENOENT') return false;
    refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir', reason: 'lock-unverified' });
  })) return true;
  return false;
}
const lockName = (configDir: string) => createHash('sha256').update(configDir).digest('hex').slice(0, 32);
/** This hashes a metadata filename, never the opaque capacity resource identity. */
export const loginRecordPath = (configDir: string, stateDir: string) => join(dirname(stateDir), LOCK_DIR, `${lockName(configDir)}.login`);
export const loginLockPath = (configDir: string, stateDir: string) => join(dirname(stateDir), LOCK_DIR, `${lockName(configDir)}.lock`);
const read = async (path: string) => {
  try { return (await readPinnedFile(path))?.bytes.toString('utf8') ?? null; }
  catch { refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'lock-marker-read' }); }
};
/** Legacy marker compatibility: only a provably absent PID is reclaimable. Age, malformed records and PID reuse never prove release. */
async function legacyBusy(path: string): Promise<LegacyBusy | null> {
  const text = await read(path);
  if (text === null) return null;
  let holder: Partial<Holder>;
  try { holder = JSON.parse(text) as Partial<Holder>; } catch { return 'legacy-unverified'; }
  if (!holder || !Number.isSafeInteger(holder.pid) || holder.pid! <= 0 || typeof holder.token !== 'string') return 'legacy-unverified';
  // A v2 marker is advisory: acquiring the permanent kernel inode proves its v2 owner no longer holds custody.
  if (holder.schemaVersion !== 2) {
    const pid = probeProcessExistence(holder.pid!);
    if (pid !== 'absent') return pid === 'present' ? 'legacy-process' : 'legacy-process-unverified';
  }
  await rm(path).catch(() => refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'lock-marker-remove' }));
  return null;
}

function releaseGuard(lock: ExclusiveFileLock): void {
  try { lock.release(); }
  catch { refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'lock-guard-release' }); }
}

async function removeOwnMarker(path: string, token: string): Promise<void> {
  const text = await read(path);
  if (text === null) return;
  let recorded: unknown;
  try { recorded = (JSON.parse(text) as Partial<Holder>).token; }
  catch { refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'lock-marker-parse' }); }
  if (recorded === token) await rm(path).catch(() => refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'lock-marker-remove' }));
}

function acquisitionFailed(error: unknown, signal: AbortSignal | undefined): never {
  if (signal?.aborted && (error === signal.reason || error instanceof Error && error.name === 'AbortError')) throw error;
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case 'LOCAL_RUNTIME_OPTIONS': return refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'login-lock', reason: 'guard-path' });
    case 'LOCAL_RUNTIME_NATIVE_UNAVAILABLE': return refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'login-lock', reason: 'native-unavailable' });
    case 'LOCAL_RUNTIME_ENDPOINT_UNSAFE': return refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'login-lock', reason: 'guard-unsafe' });
    default: return refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'login-lock', reason: 'guard-acquire' });
  }
}

/** One non-expiring kernel lock per login, held through process settlement, including approval waits.
 * The companion inode is permanent: unlinking a flock file would let another waiter lock a different inode.
 * A legacy marker is inspected/removed only under this lock, closing the old compare/remove race. */
export async function withLoginLock<T>(entry: HeadlessEntry, configDir: string, stateDir: string, now: () => number, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const { names, waitMs, pollMs } = entry.headless.isolation.refreshLock, directory = join(dirname(stateDir), LOCK_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'lock-directory-create' }));
  const info = await lstat(directory).catch(() => refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'lock-directory-read' }));
  if (!info.isDirectory()) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'lock-directory-type' });
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'lock-directory-private' });
  const path = loginLockPath(configDir, stateDir), token = randomUUID(), deadline = performance.now() + waitMs;
  let lock: ExclusiveFileLock | null;
  for (;;) {
    let holder: 'cli' | 'guard' | LegacyBusy = 'guard';
    lock = await withExclusiveFileLock(`${path}.guard`, { waitMs: Math.max(0, deadline - performance.now()), pollMs, signal })
      .catch((error: unknown) => acquisitionFailed(error, signal));
    if (lock) {
      try {
        const legacy = await legacyBusy(path);
        if (legacy) holder = legacy;
        else if (await cliLockHeld(configDir, names)) holder = 'cli';
        else {
          await writeFile(path, JSON.stringify({ schemaVersion: 2, pid: process.pid, atMs: now(), token }), { mode: 0o600, flag: 'wx' })
            .catch(() => refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'lock-marker-write' }));
          break;
        }
      } catch (error) {
        try { releaseGuard(lock); } catch { /* Keep the acquisition failure. */ }
        throw error;
      }
      releaseGuard(lock);
    }
    if (performance.now() >= deadline) refuse('HEADLESS_LOGIN_BUSY', { holder });
    await delay(pollMs, undefined, signal ? { signal } : undefined);
  }
  let failed = false;
  try { signal?.throwIfAborted(); return await run(); }
  catch (error) { failed = true; throw error; }
  finally {
    await removeOwnMarker(path, token).catch((error: unknown) => {
      if (!failed) { failed = true; throw error; }
    }).finally(() => {
      try { releaseGuard(lock); }
      catch (error) { if (!failed) throw error; }
    });
  }
}
