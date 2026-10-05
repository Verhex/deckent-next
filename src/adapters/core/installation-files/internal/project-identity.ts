import { randomUUID } from 'node:crypto';
import { projectIdentitySchema } from '#domain/index.js';
import { ProjectIdentityError, type ProjectIdentityStore } from '#engine/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { IdentityFile } from './identity-file.js';

/** The fixed anchor travels with the project, independently of its execution data root. */
export class FileProjectIdentityStore implements ProjectIdentityStore {
  constructor(private readonly projectRoot: string, private readonly lockTimeoutMs?: number) {}
  async loadOrCreate() {
    try {
      return await new IdentityFile(resolveProductLayout({ projectRoot: this.projectRoot }), 'projectIdentity', {
        parse: value => projectIdentitySchema.parse(value),
        create: () => projectIdentitySchema.parse({ schemaVersion: 1, projectId: randomUUID() }),
        error: reason => new ProjectIdentityError(({ INVALID: 'PROJECT_IDENTITY_INVALID', UNAVAILABLE: 'PROJECT_IDENTITY_UNAVAILABLE',
          LOCKED: 'PROJECT_IDENTITY_LOCKED', UNSUPPORTED: 'PROJECT_IDENTITY_UNAVAILABLE' } as const)[reason]),
      }, this.lockTimeoutMs).loadOrCreate();
    } catch (error) {
      if (error instanceof ProjectIdentityError) throw error;
      throw new ProjectIdentityError('PROJECT_IDENTITY_UNAVAILABLE');
    }
  }
}
