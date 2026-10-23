import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { refuse } from './contract.js';
import type { HeadlessEntry } from './env.js';

/** Deckent's own per-login-dir locks, beside the connections' state dirs (one global headless root per person): never inside the login dir. */
const LOCK_DIR = 'login-locks';
type Holder = Readonly<{ pid: number; atMs: number; token: string }>;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: unknown }).code === 'EPERM'; } };
async function cliLockHeld(configDir: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) if (await lstat(join(configDir, name)).then(() => true, () => false)) return true;
  return false;
}
/** A held Deckent lock is stale when unreadable, its process is gone or it is older than `staleMs` (a reused process id). */
const read = (path: string) => readFile(path, 'utf8').then(text => text, () => null);
/** The stale holder's exact text, or null when the lock is live. Removal compares that text again right before it (a narrow race remains between the
 * compare and the remove; two waiters that both judged one holder stale may then both hold, never a live holder's lock past its stale bound). */
async function stale(path: string, now: number, staleMs: number): Promise<string | null> {
  const text = await read(path);
  if (text === null) return null;
  let holder: Partial<Holder> | null = null; try { holder = JSON.parse(text) as Partial<Holder>; } catch { /* Unreadable: stale. */ }
  return !holder || typeof holder.pid !== 'number' || typeof holder.atMs !== 'number' || !alive(holder.pid) || now - holder.atMs > staleMs ? text : null;
}
/**
 * f5: one headless spawn per login dir at a time across this person's connections, and none while the CLI's own refresh lock exists there (the
 * person's interactive session may be refreshing the login; Deckent only looks at the name, never the file). Waits up to the registry bound, then
 * refuses typed (`HEADLESS_LOGIN_BUSY`, holder `cli` or `deckent`). The lock is a 0600 file created exclusively and removed only by its own token.
 */
export async function withLoginLock<T>(entry: HeadlessEntry, configDir: string, stateDir: string, now: () => number, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const { names, waitMs, pollMs, staleMs } = entry.headless.isolation.refreshLock, directory = join(dirname(stateDir), LOCK_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'state-dir' });
  const path = join(directory, `${createHash('sha256').update(configDir).digest('hex').slice(0, 32)}.lock`), token = randomUUID(), deadline = performance.now() + waitMs;
  let holder: 'cli' | 'deckent';
  for (;;) {
    signal?.throwIfAborted();
    const acquired = await writeFile(path, JSON.stringify({ pid: process.pid, atMs: now(), token }), { mode: 0o600, flag: 'wx' }).then(() => true, async (error: unknown) => {
      if ((error as { code?: unknown }).code !== 'EEXIST') refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'state-dir' });
      const old = await stale(path, now(), staleMs);
      if (old !== null && await read(path) === old) await rm(path, { force: true });
      return false;
    });
    if (acquired) {
      if (!await cliLockHeld(configDir, names)) break;
      holder = 'cli'; await rm(path, { force: true });
    } else holder = 'deckent';
    // The wait is measured on the monotonic clock; `now` stamps the holder record (its stale age).
    if (performance.now() >= deadline) refuse('HEADLESS_LOGIN_BUSY', { holder });
    await delay(pollMs, undefined, signal ? { signal } : undefined);
  }
  try { return await run(); }
  finally {
    const current = await readFile(path, 'utf8').then(text => (JSON.parse(text) as Partial<Holder>).token, () => null);
    if (current === token) await rm(path, { force: true });
  }
}
