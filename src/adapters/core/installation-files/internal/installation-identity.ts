import { randomUUID } from 'node:crypto';
import { installationIdentitySchema } from '#domain/index.js';
import { InstallationIdentityError, type InstallationIdentityStore } from '#engine/index.js';
import type { ProductLayout } from '#platform/index.js';
import { IdentityFile } from './identity-file.js';

/** Installation metadata follows the resolved data root, shared by projects using that installation. */
export class FileInstallationIdentityStore implements InstallationIdentityStore {
  constructor(private readonly layout: ProductLayout, private readonly lockTimeoutMs?: number) {}
  loadOrCreate() {
    return new IdentityFile(this.layout, 'installationIdentity', {
      parse: value => installationIdentitySchema.parse(value),
      create: () => installationIdentitySchema.parse({ schemaVersion: 1, installationId: randomUUID() }),
      error: reason => new InstallationIdentityError(({ INVALID: 'INSTALLATION_IDENTITY_INVALID', UNAVAILABLE: 'INSTALLATION_IDENTITY_UNAVAILABLE',
        LOCKED: 'INSTALLATION_IDENTITY_LOCKED', UNSUPPORTED: 'INSTALLATION_IDENTITY_UNSUPPORTED' } as const)[reason]),
    }, this.lockTimeoutMs).loadOrCreate();
  }
}
