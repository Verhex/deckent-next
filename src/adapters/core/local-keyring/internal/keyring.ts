import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ErrorRegistry, inspectProductDirectory, prepareProductDirectory, createHmacIntegrity, sha256, withConfigWriteLock, type ProductLayout } from '#platform/index.js';

/** Every local key is 256 bit (32 bytes): a versioned cryptographic invariant, not an operational limit or configuration. */
const KEY_LENGTH = 32;

/** Private local key custody, not an OS keyring. The directory must remain outside worker mounts. */
export async function openLocalIntegrityAuthority(layout: ProductLayout, filename: string, create = false) {
  return withLocalKey(layout, filename, create, 'INTEGRITY_KEY_UNAVAILABLE', material => createHmacIntegrity(sha256(material.toString('hex')), material));
}

/** The installation's own 256-bit prefix-cache salt secret (VLLM-CACHE-SALT, owner 2026-10-07): a separate file next to, never derived
 * from, the integrity key; same custody (0600, owner, one link, O_NOFOLLOW). Created at init and, for an older installation, on first use.
 * Rotation: replace or remove the file (the next use creates a new one); every scope then gets a new salt and a cold prefix cache. */
export const PREFIX_CACHE_SALT_KEY_FILE = 'prefix-cache-salt.key';
/** cache_salt = HMAC-SHA256(installation secret, scopeId), base64url: 43 characters (256 bit), stable per secret and scope. */
export function derivePrefixCacheSalt(secret: Uint8Array, scopeId: string): string {
  if (secret.byteLength !== KEY_LENGTH || typeof scopeId !== 'string' || !scopeId) throw ErrorRegistry.createError('PREFIX_CACHE_SALT_UNAVAILABLE');
  return createHmac('sha256', secret).update(scopeId, 'utf8').digest('base64url');
}
/** The salt of one scope; an unsafe, unreadable or (with `create` false) absent secret is `PREFIX_CACHE_SALT_UNAVAILABLE`, never a fallback.
 * `integrityKeyFile` is the configured integrity key name: a configuration naming the salt file as that key is refused (one key, one use). */
export async function localPrefixCacheSalt(layout: ProductLayout, scopeId: string, integrityKeyFile: string, create = true): Promise<string> {
  if (integrityKeyFile === PREFIX_CACHE_SALT_KEY_FILE) throw ErrorRegistry.createError('PREFIX_CACHE_SALT_UNAVAILABLE');
  return withLocalKey(layout, PREFIX_CACHE_SALT_KEY_FILE, create, 'PREFIX_CACHE_SALT_UNAVAILABLE', secret => derivePrefixCacheSalt(secret, scopeId));
}
/** Creates the salt secret when absent (init); an existing one is only checked. */
export async function ensureLocalPrefixCacheSaltKey(layout: ProductLayout): Promise<void> {
  await withLocalKey(layout, PREFIX_CACHE_SALT_KEY_FILE, true, 'PREFIX_CACHE_SALT_UNAVAILABLE', () => undefined);
}

async function withLocalKey<T>(layout: ProductLayout, filename: string, create: boolean, failure: 'INTEGRITY_KEY_UNAVAILABLE' | 'PREFIX_CACHE_SALT_UNAVAILABLE',
  use: (material: Buffer) => T): Promise<T> {
  try {
    const directory = create ? await prepareProductDirectory(layout, 'approvals') : await inspectProductDirectory(layout, 'approvals');
    return await withPrivateKeyFile(directory, filename, create, use);
  } catch { throw ErrorRegistry.createError(failure); }
}

/**
 * One 256-bit key file in an existing private directory, under the local-key custody rules: opened without following links, a regular
 * single-linked file of this user with mode 0600 and exactly 32 bytes. With `create`, an absent file is created exclusively (O_EXCL) from
 * fresh random bytes, fsynced with its directory, under the bounded path lock; an existing one is only checked, never replaced. Without
 * `create` no lock is written. The material is zeroed after `use`. Failures are raw (`ENOENT` for an absent key); callers type them.
 */
export async function withPrivateKeyFile<T>(directory: string, filename: string, create: boolean, use: (material: Buffer) => T): Promise<T> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(filename)) throw new Error('name');
  const path = join(directory, filename);
  // Write mode uses the existing bounded path lock; read mode performs no lock writes.
  const access = create ? withConfigWriteLock : async <T>(_path: string, work: () => Promise<T>) => work();
  return access(path, async () => {
    let handle; let created = false;
    try {
      handle = await open(path, create ? constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW : constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
      created = create;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    try {
      const info = await handle.stat(); const linked = await lstat(path);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600
        || linked.isSymbolicLink() || linked.ino !== info.ino || linked.dev !== info.dev) throw new Error('custody');
      if (created) {
        const material = randomBytes(KEY_LENGTH);
        try { await handle.writeFile(material); await handle.sync(); } finally { material.fill(0); }
        const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await parent.sync(); } finally { await parent.close(); }
      }
      if ((await handle.stat()).size !== KEY_LENGTH) throw new Error('size');
      const material = Buffer.alloc(KEY_LENGTH);
      try {
        if ((await handle.read(material, 0, KEY_LENGTH, 0)).bytesRead !== KEY_LENGTH) throw new Error('read');
        return use(material);
      } finally { material.fill(0); }
    } finally { await handle.close(); }
  });
}
