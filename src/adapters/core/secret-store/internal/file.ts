import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DeckentError, ErrorRegistry, withConfigWriteLock, writeJsonAtomic } from '#platform/index.js';
import { SECRET_NAME_PATTERN, SECRET_VALUE_MAX_BYTES, isSecretName, isSecretValue, type SecretStore, type SecretStoreErrorCode, type SecretStoreFactory,
  type SecretStoreContext, type SecretStoreInspection } from '#engine/index.js';

export const FILE_SECRET_STORE_ID = 'core.secret-store.file@1';
export const FILE_SECRET_STORE_NAME = 'secrets.json';
const MAX_DOCUMENT_BYTES = 1_048_576;
/** Store document v1: names in the `$DECK` grammar, bounded non-empty values; nothing else. */
const documentSchema = z.object({ schemaVersion: z.literal(1),
  secrets: z.record(z.string().regex(SECRET_NAME_PATTERN), z.string().min(1).max(SECRET_VALUE_MAX_BYTES)) }).strict();

export interface FileSecretStoreOptions {
  /** The installation (global) root; null when none resolves (no HOME and no override): the store is then unavailable. */
  readonly root: string | null;
  readonly platform: string;
  /** Bound on waiting for the store's write lock (the config writer lock, per path); contention is `CONFIG_WRITE_LOCKED`. */
  readonly lockTimeoutMs?: number;
}
const fail = (code: SecretStoreErrorCode, params: Record<string, string> = {}) => ErrorRegistry.createError(code, { params: { backend: FILE_SECRET_STORE_ID, ...params } });
const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/**
 * `core.secret-store.file@1` (SECRET-K1): `<global root>/secrets.json`, owner-only. Custody (the local-keyring and managed-file rules):
 * the directory is a real directory of this user with no group/other access (created 0700 on the first write); the file is opened without
 * following links and must be a single-linked regular file of this user with no group/other permission — anything else is
 * `SECRET_STORE_UNSAFE` and nothing is read or repaired. Writes hold the config writer lock of this path, re-read under it, and replace the
 * file atomically (0600 temporary file, fsync, rename, directory fsync). Content never enters an error: a JSON parse message can quote the
 * text, so a corrupt store is `SECRET_STORE_CORRUPT` without a cause. POSIX only (Windows is later in the accepted OS order).
 * This is plaintext at rest protected by file ownership — a process of the same user can read it; the OS keyring backend is K2.
 */
export function createFileSecretStore(options: FileSecretStoreOptions): SecretStore {
  const root = options.root, path = root === null ? null : join(root, FILE_SECRET_STORE_NAME);
  const uid = (): number => {
    if (options.platform === 'win32' || root === null || typeof process.getuid !== 'function') throw fail('SECRET_STORE_UNAVAILABLE');
    return process.getuid();
  };
  const unsafe = () => fail('SECRET_STORE_UNSAFE', { path: root ?? '' });
  const privateDirectory = (info: Stats, owner: number) => {
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== owner || (info.mode & 0o077) !== 0) throw unsafe();
  };
  /** false: the directory does not exist (an empty store); it is created only for a write. */
  async function directory(owner: number, create: boolean): Promise<boolean> {
    let info: Stats | null;
    try { info = await lstat(root!); } catch (error) { if (!missing(error)) throw fail('SECRET_STORE_UNAVAILABLE'); info = null; }
    if (!info) {
      if (!create) return false;
      try { await mkdir(root!, { recursive: true, mode: 0o700 }); info = await lstat(root!); } catch { throw fail('SECRET_STORE_UNAVAILABLE'); }
    }
    privateDirectory(info, owner);
    return true;
  }
  async function read(owner: number): Promise<Record<string, string>> {
    const empty = Object.create(null) as Record<string, string>;
    if (!await directory(owner, false)) return empty;
    let handle;
    try { handle = await open(path!, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (missing(error)) return empty;
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw unsafe();
      throw fail('SECRET_STORE_UNAVAILABLE');
    }
    try {
      const info = await handle.stat(), linked = await lstat(path!);
      if (!info.isFile() || info.uid !== owner || info.nlink !== 1 || (info.mode & 0o077) !== 0
        || linked.isSymbolicLink() || linked.ino !== info.ino || linked.dev !== info.dev) throw unsafe();
      if (info.size > MAX_DOCUMENT_BYTES) throw fail('SECRET_STORE_CORRUPT');
      let parsed: unknown;
      try { parsed = JSON.parse(await handle.readFile('utf8')); } catch { throw fail('SECRET_STORE_CORRUPT'); }
      const document = documentSchema.safeParse(parsed);
      if (!document.success) throw fail('SECRET_STORE_CORRUPT');
      return Object.assign(empty, document.data.secrets);
    } catch (error) {
      if (error instanceof DeckentError) throw error;
      throw fail('SECRET_STORE_UNAVAILABLE');
    } finally { await handle.close(); }
  }
  async function write<T>(change: (secrets: Record<string, string>) => { readonly write: boolean; readonly result: T }): Promise<T> {
    const owner = uid();
    await directory(owner, true);
    return withConfigWriteLock(path!, async () => {
      const secrets = await read(owner), outcome = change(secrets);
      if (outcome.write) {
        const sorted = Object.fromEntries(Object.keys(secrets).sort().map(name => [name, secrets[name]!]));
        try { await writeJsonAtomic(path!, { schemaVersion: 1, secrets: sorted }); } catch { throw fail('SECRET_STORE_UNAVAILABLE'); }
      }
      return outcome.result;
    }, options.lockTimeoutMs ?? 2_000);
  }
  return Object.freeze({
    descriptor: Object.freeze({ id: FILE_SECRET_STORE_ID, writable: true, enumerable: true }),
    async get(name: string) {
      const owner = uid();
      // A name outside the grammar can never have been stored.
      if (!isSecretName(name)) return undefined;
      return (await read(owner))[name];
    },
    async set(name: string, value: string) {
      if (!isSecretName(name)) throw fail('SECRET_NAME_INVALID');
      if (!isSecretValue(value)) throw fail('SECRET_VALUE_INVALID');
      await write(secrets => { secrets[name] = value; return { write: true, result: undefined }; });
    },
    async delete(name: string) {
      if (!isSecretName(name)) throw fail('SECRET_NAME_INVALID');
      return write(secrets => {
        if (!Object.hasOwn(secrets, name)) return { write: false, result: false };
        delete secrets[name]; return { write: true, result: true };
      });
    },
    async listNames() { return Object.freeze(Object.keys(await read(uid())).sort()); },
    async inspect(): Promise<SecretStoreInspection> {
      try { await read(uid()); return Object.freeze({ status: 'ready', code: null }); }
      catch (error) {
        const code = error instanceof DeckentError ? error.code : '';
        return Object.freeze(code === 'SECRET_STORE_UNSAFE' ? { status: 'unsafe', code } : code === 'SECRET_STORE_CORRUPT' ? { status: 'corrupt', code }
          : { status: 'unavailable', code: 'SECRET_STORE_UNAVAILABLE' });
      }
    },
  });
}
/** The registered factory: the store lives in the installation root the caller's environment resolves (null → unavailable). */
export const fileSecretStoreFactory: SecretStoreFactory = Object.freeze({ id: FILE_SECRET_STORE_ID,
  create: (context: SecretStoreContext) => createFileSecretStore({ root: context.root, platform: context.platform }) });
