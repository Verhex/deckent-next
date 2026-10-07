import { lstat, mkdir, stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ManagedFileError, getConfigFieldDefault, inspectProductDirectory, prepareProductCompanionPath, productResourcePath, readJsonFile,
  withConfigWriteLock, writeJsonAtomic, type ProductLayout } from '#platform/index.js';

type IdentityResource = 'projectIdentity' | 'installationIdentity';
/** The poll step keeps a concurrent first publication cheap to observe; the bound is the writer-lock timeout. */
const PUBLICATION_POLL_MS = 10;
type Failure = 'INVALID' | 'UNAVAILABLE' | 'LOCKED' | 'UNSUPPORTED' | 'MASKED';
/** Linux `TMPFS_MAGIC` (statfs(2)). */
const TMPFS_MAGIC = 0x01021994;
/**
 * B5 (owner terminal test 2026-10-07): inside a Deckent shell sandbox the product state is hidden by mounting an empty tmpfs over each of its
 * directories, so a command run there (`deckent doctor`) finds the identity directory present but empty — which read as retained loss
 * ("restore from backup"). A record directory that is its own tmpfs mount (another device than its parent) is that mask: Deckent never
 * mounts anything on it. Observed only; any doubt (no statfs, another platform) keeps the loss reading.
 */
async function maskedDirectory(directory: string): Promise<boolean> {
  try {
    const [own, parent, fs] = await Promise.all([stat(directory), stat(dirname(directory)), statfs(directory)]);
    return Number(fs.type) === TMPFS_MAGIC && own.dev !== parent.dev;
  } catch { return false; }
}
class IdentityFileError extends Error { constructor(readonly reason: Failure) { super(reason); } }
/** `prepare` runs under the writer lock before the record directory is created, so its refusal leaves no retained (lost-looking) directory. */
interface IdentityCodec<T, P = undefined> { parse(value: unknown): T; prepare?(): Promise<P>; create(prepared: P | undefined): T | Promise<T>; error(reason: Failure): Error; isError?(error: unknown): boolean }

/** Shared first-publication mechanism. A retained directory with a missing record means lost or
 * interrupted publication, never a fresh identity. The bounded config lock serializes writers;
 * established identities are read without a lock. Failure deliberately retains the directory.
 */
export class IdentityFile<T, P = undefined> {
  constructor(private readonly layout: ProductLayout, private readonly resource: IdentityResource,
    private readonly codec: IdentityCodec<T, P>, private readonly lockTimeoutMs?: number) {}

  private async read(directory: string): Promise<T | null> {
    const path = join(directory, 'identity.json');
    const stat = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || (stat.mode & 0o777) !== 0o600) throw new IdentityFileError('INVALID');
    const read = await readJsonFile(path);
    if (read.kind === 'io') throw new IdentityFileError('UNAVAILABLE');
    if (read.kind !== 'ready') throw new IdentityFileError('INVALID');
    try { return this.codec.parse(read.value); } catch { throw new IdentityFileError('INVALID'); }
  }

  /** Absence is observed without locks, directories, healing or publication. Retained loss is invalid. */
  async load(): Promise<T | null> {
    try {
      const directory = productResourcePath(this.layout, this.resource);
      try { await inspectProductDirectory(this.layout, this.resource); }
      catch (error) {
        if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return null;
        throw error;
      }
      const first = await this.read(directory);
      if (!first && await maskedDirectory(directory)) throw new IdentityFileError('MASKED');
      const record = first ?? await this.settled(directory);
      if (!record) throw new IdentityFileError('INVALID');
      return record;
    } catch (error) { return this.fail(error); }
  }

  /**
   * First publication creates the directory and then the record under the writer lock, so an unlocked reader can see the
   * directory before the record. Re-read without locks or writes for at most the writer-lock bound; a record that is still
   * missing afterwards is retained loss (INVALID), never a fresh identity.
   */
  private async settled(directory: string): Promise<T | null> {
    // Monotonic, so a wall-clock step neither stretches the wait nor ends it early (Astra 2359 P2).
    const deadline = performance.now() + (this.lockTimeoutMs ?? getConfigFieldDefault('configFile').writeLockTimeoutMs);
    while (performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, PUBLICATION_POLL_MS));
      const record = await this.read(directory);
      if (record) return record;
    }
    return null;
  }

  /** Existing-record replacement uses the same custody and atomic writer as first publication. Returning the current record unchanged writes nothing. */
  async update(change: (record: T) => Promise<T>): Promise<T> {
    try {
      const directory = productResourcePath(this.layout, this.resource);
      await inspectProductDirectory(this.layout, this.resource);
      await prepareProductCompanionPath(this.layout, this.resource, '-lock');
      return await withConfigWriteLock(directory, async () => {
        await inspectProductDirectory(this.layout, this.resource);
        const current = await this.read(directory);
        if (!current) throw new IdentityFileError('INVALID');
        const next = await change(current);
        if (next !== current) await writeJsonAtomic(join(directory, 'identity.json'), next);
        return next;
      }, this.lockTimeoutMs);
    } catch (error) { return this.fail(error); }
  }

  private fail(error: unknown): never {
    const code = (error as { code?: string }).code;
    if (this.codec.isError?.(error)) throw error;
    throw this.codec.error(error instanceof IdentityFileError ? error.reason : code === 'CONFIG_WRITE_LOCKED'
      ? 'LOCKED' : code === 'MANAGED_FILE_UNSUPPORTED' ? 'UNSUPPORTED' : 'UNAVAILABLE');
  }

  async loadOrCreate(): Promise<T> {
    try {
      const { layout, resource } = this;
      const directory = productResourcePath(layout, resource);
      try {
        await inspectProductDirectory(layout, resource);
        const record = await this.read(directory);
        if (record) return record; // Established identities require no lock or writes.
      } catch (error) {
        if (!(error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING')) throw error;
      }
      await prepareProductCompanionPath(layout, resource, '-lock');
      return await withConfigWriteLock(directory, async () => {
        const prepared = await this.codec.prepare?.();
        let fresh = false;
        try { await mkdir(directory, { mode: 0o700 }); fresh = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        await inspectProductDirectory(layout, resource);
        const path = join(directory, 'identity.json');
        if (fresh) {
          const record = await this.codec.create(prepared);
          await writeJsonAtomic(path, record);
          return record;
        }
        const record = await this.read(directory);
        if (!record) throw new IdentityFileError('INVALID');
        return record;
      }, this.lockTimeoutMs);
    } catch (error) { return this.fail(error); }
  }
}
