import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLedgerLock, type LedgerLock } from '#adapters/core/local-runtime-socket/index.js';
import { readPinnedFile } from '#platform/index.js';
import { refuse } from './contract.js';
import type { HeadlessEntry } from './env.js';

const LOCK_DIR = 'login-locks';
type Holder = Readonly<{ schemaVersion?: 2; pid: number; atMs: number; token: string }>;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: unknown }).code !== 'ESRCH'; } };
async function cliLockHeld(configDir: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) if (await lstat(join(configDir, name)).then(() => true, error => {
    if ((error as { code?: unknown }).code === 'ENOENT') return false;
    refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' });
  })) return true;
  return false;
}
const lockName = (configDir: string) => createHash('sha256').update(configDir).digest('hex').slice(0, 32);
/** This hashes a metadata filename, never the opaque capacity resource identity. */
export const loginRecordPath = (configDir: string, stateDir: string) => join(dirname(stateDir), LOCK_DIR, `${lockName(configDir)}.login`);
const read = async (path: string) => {
  try { return (await readPinnedFile(path))?.bytes.toString('utf8') ?? null; }
  catch { refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'state-dir' }); }
};
/** Legacy marker compatibility: only a provably absent PID is reclaimable. Age, malformed records and PID reuse never prove release. */
async function legacyBusy(path: string): Promise<boolean> {
  const text = await read(path);
  if (text === null) return false;
  let holder: Partial<Holder>;
  try { holder = JSON.parse(text) as Partial<Holder>; } catch { return true; }
  if (!holder || !Number.isSafeInteger(holder.pid) || holder.pid! <= 0 || typeof holder.token !== 'string') return true;
  // A v2 marker is advisory: acquiring the permanent kernel inode proves its v2 owner no longer holds custody.
  if (holder.schemaVersion !== 2 && alive(holder.pid!)) return true;
  await rm(path); return false;
}
/** One non-expiring kernel lock per login, held through process settlement, including approval waits.
 * The companion inode is permanent: unlinking a flock file would let another waiter lock a different inode.
 * A legacy marker is inspected/removed only under this lock, closing the old compare/remove race. */
export async function withLoginLock<T>(entry: HeadlessEntry, configDir: string, stateDir: string, now: () => number, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const { names, waitMs, pollMs } = entry.headless.isolation.refreshLock, directory = join(dirname(stateDir), LOCK_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'state-dir' });
  const path = join(directory, `${lockName(configDir)}.lock`), token = randomUUID(), deadline = performance.now() + waitMs;
  let lock: LedgerLock | undefined;
  for (;;) {
    signal?.throwIfAborted();
    let holder: 'cli' | 'deckent' = 'deckent';
    try { lock = acquireLedgerLock(`${path}.guard`); }
    catch (error) {
      if ((error as { code?: unknown }).code !== 'LOCAL_RUNTIME_ALREADY_RUNNING') refuse('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'login-lock' });
    }
    if (lock) {
      try {
        if (!await legacyBusy(path)) {
          if (!await cliLockHeld(configDir, names)) {
            await writeFile(path, JSON.stringify({ schemaVersion: 2, pid: process.pid, atMs: now(), token }), { mode: 0o600, flag: 'wx' });
            break;
          }
          holder = 'cli';
        }
      } catch (error) { lock.release(); throw error; }
      lock.release(); lock = undefined;
    }
    if (performance.now() >= deadline) refuse('HEADLESS_LOGIN_BUSY', { holder });
    await delay(pollMs, undefined, signal ? { signal } : undefined);
  }
  try { signal?.throwIfAborted(); return await run(); }
  finally {
    try {
      const text = await read(path);
      if (text !== null && (JSON.parse(text) as Partial<Holder>).token === token) await rm(path);
    } finally { lock.release(); }
  }
}
