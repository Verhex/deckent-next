import { randomUUID } from 'node:crypto';
import { projectIdentitySchema, type ProjectIdentity } from '#domain/index.js';
import { ProjectIdentityError, type ProjectIdentityStore, type IdentityRead } from '#engine/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { IdentityFile } from './identity-file.js';

/** The fixed anchor travels with the project, independently of its execution data root. */
export class FileProjectIdentityStore implements ProjectIdentityStore {
  constructor(private readonly projectRoot: string, private readonly lockTimeoutMs?: number) {}
  async read(): Promise<IdentityRead<ProjectIdentity>> {
    // The storage custody contract is POSIX-only; an optional metadata read must not block commands.
    if (process.platform === 'win32') return { status: 'unavailable', reason: 'unsupported' };
    const value = await this.load(false);
    return value ? { status: 'available', value } : { status: 'unavailable', reason: 'not-created' };
  }
  async loadOrCreate() { return (await this.load(true))!; }
  private async load(create: boolean) {
    try {
      const file = new IdentityFile(resolveProductLayout({ projectRoot: this.projectRoot }), 'projectIdentity', {
        parse: value => projectIdentitySchema.parse(value),
        create: () => projectIdentitySchema.parse({ schemaVersion: 1, projectId: randomUUID() }),
        error: reason => new ProjectIdentityError(({ INVALID: 'PROJECT_IDENTITY_INVALID', UNAVAILABLE: 'PROJECT_IDENTITY_UNAVAILABLE',
          LOCKED: 'PROJECT_IDENTITY_LOCKED', UNSUPPORTED: 'PROJECT_IDENTITY_UNAVAILABLE' } as const)[reason]),
      }, this.lockTimeoutMs);
      return await (create ? file.loadOrCreate() : file.load());
    } catch (error) {
      if (error instanceof ProjectIdentityError) throw error;
      throw new ProjectIdentityError('PROJECT_IDENTITY_UNAVAILABLE');
    }
  }
}
