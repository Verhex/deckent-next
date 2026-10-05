import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { projectIdentitySchema, type ProjectIdentity } from '#domain/index.js';
import { ProjectIdentityError, type ProjectIdentityStore } from '#engine/index.js';
import { ManagedFileError, inspectProductDirectory, prepareProductCompanionPath, productResourcePath, readJsonFile,
  resolveProductLayout, withConfigWriteLock, writeJsonAtomic } from '#platform/index.js';

/** The fixed project anchor travels with the project, even when its execution data root is elsewhere.
 * A retained directory with a missing record is an interrupted/lost publication, never a fresh project.
 * The existing bounded config lock serializes first publication across processes. The directory is
 * deliberately retained on failure, so an uncertain publication cannot silently mint another identity.
 */
export class FileProjectIdentityStore implements ProjectIdentityStore {
  constructor(private readonly projectRoot: string, private readonly lockTimeoutMs?: number) {}

  private async read(directory: string): Promise<ProjectIdentity | null> {
    const path = join(directory, 'identity.json');
    const stat = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || (stat.mode & 0o777) !== 0o600) throw new ProjectIdentityError('PROJECT_IDENTITY_INVALID');
    const read = await readJsonFile(path);
    if (read.kind === 'io') throw new ProjectIdentityError('PROJECT_IDENTITY_UNAVAILABLE');
    const parsed = read.kind === 'ready' ? projectIdentitySchema.safeParse(read.value) : null;
    if (!parsed?.success) throw new ProjectIdentityError('PROJECT_IDENTITY_INVALID');
    return parsed.data;
  }

  async loadOrCreate(): Promise<ProjectIdentity> {
    try {
      const layout = resolveProductLayout({ projectRoot: this.projectRoot });
      const directory = productResourcePath(layout, 'projectIdentity');
      try {
        await inspectProductDirectory(layout, 'projectIdentity');
        const record = await this.read(directory);
        if (record) return record; // Established identities require no lock or writes.
      } catch (error) {
        if (!(error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING')) throw error;
      }
      await prepareProductCompanionPath(layout, 'projectIdentity', '-lock');
      return await withConfigWriteLock(directory, async () => {
        let fresh = false;
        try { await mkdir(directory, { mode: 0o700 }); fresh = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        await inspectProductDirectory(layout, 'projectIdentity');
        const path = join(directory, 'identity.json');
        if (fresh) {
          const record = projectIdentitySchema.parse({ schemaVersion: 1, projectId: randomUUID() });
          await writeJsonAtomic(path, record);
          return record;
        }
        const record = await this.read(directory);
        if (!record) throw new ProjectIdentityError('PROJECT_IDENTITY_INVALID');
        return record;
      }, this.lockTimeoutMs);
    } catch (error) {
      if (error instanceof ProjectIdentityError) throw error;
      throw new ProjectIdentityError((error as { code?: string }).code === 'CONFIG_WRITE_LOCKED'
        ? 'PROJECT_IDENTITY_LOCKED' : 'PROJECT_IDENTITY_UNAVAILABLE');
    }
  }
}
