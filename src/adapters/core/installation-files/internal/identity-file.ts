import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ManagedFileError, inspectProductDirectory, prepareProductCompanionPath, productResourcePath, readJsonFile,
  withConfigWriteLock, writeJsonAtomic, type ProductLayout } from '#platform/index.js';

type IdentityResource = 'projectIdentity' | 'installationIdentity';
type Failure = 'INVALID' | 'UNAVAILABLE' | 'LOCKED' | 'UNSUPPORTED';
class IdentityFileError extends Error { constructor(readonly reason: Failure) { super(reason); } }
interface IdentityCodec<T> { parse(value: unknown): T; create(): T; error(reason: Failure): Error }

/** Shared first-publication mechanism. A retained directory with a missing record means lost or
 * interrupted publication, never a fresh identity. The bounded config lock serializes writers;
 * established identities are read without a lock. Failure deliberately retains the directory.
 */
export class IdentityFile<T> {
  constructor(private readonly layout: ProductLayout, private readonly resource: IdentityResource,
    private readonly codec: IdentityCodec<T>, private readonly lockTimeoutMs?: number) {}

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
        let fresh = false;
        try { await mkdir(directory, { mode: 0o700 }); fresh = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        await inspectProductDirectory(layout, resource);
        const path = join(directory, 'identity.json');
        if (fresh) {
          const record = this.codec.create();
          await writeJsonAtomic(path, record);
          return record;
        }
        const record = await this.read(directory);
        if (!record) throw new IdentityFileError('INVALID');
        return record;
      }, this.lockTimeoutMs);
    } catch (error) {
      const code = (error as { code?: string }).code;
      throw this.codec.error(error instanceof IdentityFileError ? error.reason : code === 'CONFIG_WRITE_LOCKED'
        ? 'LOCKED' : code === 'MANAGED_FILE_UNSUPPORTED' ? 'UNSUPPORTED' : 'UNAVAILABLE');
    }
  }
}
