import { open, mkdir, unlink, lstat, rename, rmdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ErrorRegistry } from '../../errors/index.js';
import { emit } from '../../output/index.js';
import { t, resolveLocale, type Locale } from '../../i18n/index.js';
import type { ConfigWarning } from './validate/issues.js';

const STALE_MS = 10 * 60_000;
interface Owner { pid?: number; hostname?: string; createdAt?: string; nonce?: string }
export interface ConfigLockOptions { onWarning?: (warning: ConfigWarning) => void; locale?: Locale }
function pidState(pid: number): 'alive' | 'dead' | 'unknown' {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : (error as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : 'unknown'; }
}
async function observe(lock: string) {
  const stat = await lstat(lock);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw ErrorRegistry.createError('CONFIG_READ_IO_HOLD');
  const ownerPath = stat.isDirectory() ? join(lock, 'owner.json') : lock;
  let owner: Owner = {};
  try {
    const info = await lstat(ownerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw ErrorRegistry.createError('CONFIG_READ_IO_HOLD');
    const handle = await open(ownerPath, 'r');
    try {
      const opened = await handle.stat();
      if (opened.ino !== info.ino || opened.dev !== info.dev) return null;
      try {
        const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
        if (parsed && typeof parsed === 'object') {
          const value = parsed as Record<string, unknown>;
          owner = { ...(typeof value['pid'] === 'number' ? { pid: value['pid'] } : {}),
            ...(typeof value['hostname'] === 'string' ? { hostname: value['hostname'] } : {}),
            ...(typeof value['nonce'] === 'string' ? { nonce: value['nonce'] } : {}),
            ...(typeof value['createdAt'] === 'string' ? { createdAt: value['createdAt'] } : {}) };
        }
      }
      catch { /* Incomplete publication: grace period via directory mtime. */ }
    } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const empty = stat.isDirectory() && (await readdir(lock)).length === 0;
  const named = await lstat(lock);
  if (stat.ino !== named.ino || stat.dev !== named.dev || stat.mtimeMs !== named.mtimeMs) return null;
  const validPid = Number.isSafeInteger(owner.pid) && owner.pid! > 0;
  const created = typeof owner.createdAt === 'string' ? Date.parse(owner.createdAt) : NaN;
  const since = Number.isFinite(created) ? Math.min(created, stat.mtimeMs) : stat.mtimeMs;
  const ageSeconds = Math.max(0, (Date.now() - since) / 1000);
  // Legacy pid-only files were local; remote and permission-denied owners are never presumed dead.
  const local = owner.hostname === undefined || owner.hostname === hostname();
  const state = local && validPid ? pidState(owner.pid!) : 'unknown';
  const stale = state === 'dead' || (local && !validPid && ageSeconds * 1000 > STALE_MS);
  return { stat, owner, ageSeconds, stale, empty };
}
/** Keep generation tombstones: a second rename cannot overwrite a nonempty directory.
 * New owners always use directories, so even legacy FILE tombstones fence delayed reclaimers.
 * This prevents a delayed stale reclaimer from moving a newer live owner's lock (rename has no CAS).
 */
async function reclaim(lock: string, observed: NonNullable<Awaited<ReturnType<typeof observe>>>, options: ConfigLockOptions): Promise<boolean> {
  const current = await observe(lock);
  if (!current?.stale || current.stat.dev !== observed.stat.dev || current.stat.ino !== observed.stat.ino
    || current.stat.mtimeMs !== observed.stat.mtimeMs || current.owner.nonce !== observed.owner.nonce) return false;
  const stalePath = `${lock}.stale-${current.stat.dev}-${current.stat.ino}-${current.stat.birthtimeMs}`;
  try {
    if (current.empty) await rmdir(lock); // Atomic removal only while unpublished; cannot remove a populated live lock.
    else await rename(lock, stalePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'ENOENT', 'EISDIR'].includes(code)) return false;
    // Windows may report an existing protected rename destination as EPERM/EACCES.
    if (['EPERM', 'EACCES'].includes(code) && await lstat(stalePath).catch(() => null)) return false;
    throw error;
  }
  const warning: ConfigWarning = { code: 'CONFIG_LOCK_STALE_RECLAIMED', path: lock,
    message: t('config.lockReclaimed', { path: lock, pid: current.owner.pid ?? 'unknown', ageSeconds: Math.floor(current.ageSeconds) }, options.locale ?? resolveLocale()) };
  if (options.onWarning) options.onWarning(warning);
  else emit(warning, { level: 'warning', render: value => value.message });
  return true;
}
/** Exclusive directory ownership, private metadata, bounded waiting, and inode-safe release. */
export async function withConfigWriteLock<T>(path: string, fn: () => Promise<T>, timeoutMs = 2_000, options: ConfigLockOptions = {}): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.write-lock`, deadline = Date.now() + timeoutMs;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw ErrorRegistry.createError('CONFIG_READ_IO_HOLD', { cause: error });
      try {
        const owner = await observe(lock);
        if (owner?.stale && await reclaim(lock, owner, options)) continue;
        if (Date.now() >= deadline) throw ErrorRegistry.createError('CONFIG_WRITE_LOCKED', { params: {
          path: lock, pid: owner?.owner.pid ?? 'unknown', ageSeconds: Math.floor(owner?.ageSeconds ?? 0),
        } });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await sleep(25);
    }
  }
  const identity = await lstat(lock), ownerPath = join(lock, 'owner.json');
  let published = false;
  try {
    const handle = await open(ownerPath, 'wx', 0o600);
    published = true;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID(), hostname: hostname(), createdAt: new Date().toISOString() }));
      await handle.sync();
    } finally { await handle.close(); }
    const named = await lstat(lock);
    if (named.ino !== identity.ino || named.dev !== identity.dev || named.birthtimeMs !== identity.birthtimeMs) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
    return await fn();
  } finally {
    const named = await lstat(lock).catch(() => undefined);
    if (published && named?.ino === identity.ino && named.dev === identity.dev && named.birthtimeMs === identity.birthtimeMs) {
      await unlink(ownerPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      await rmdir(lock);
    }
  }
}
