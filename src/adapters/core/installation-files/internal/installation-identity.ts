import { randomUUID } from 'node:crypto';
import { boundInstallationIdentitySchema, installationBindingSchema, installationIdentityChoiceSchema, installationIdentityRecordSchema,
  installationIdentityResolutionSchema, installationIdentitySchema, type InstallationBinding, type InstallationIdentityChoice } from '#domain/index.js';
import { InstallationIdentityError, type InstallationIdentityStore, type InstallationBindingSource } from '#engine/index.js';
import type { ProductLayout } from '#platform/index.js';
import { IdentityFile } from './identity-file.js';
import { localInstallationBindingSource } from './installation-binding.js';

function matches(left: InstallationBinding, right: InstallationBinding) {
  return left.machineDigest === right.machineDigest && left.canonicalRoot === right.canonicalRoot
    && left.device === right.device && left.inode === right.inode;
}
/** One local metadata transition owner. Binding evidence detects relocation; it grants no authority. */
export class FileInstallationIdentityStore implements InstallationIdentityStore {
  constructor(private readonly layout: ProductLayout, private readonly lockTimeoutMs?: number,
    private readonly bindingSource?: InstallationBindingSource) {}
  private async source() { return this.bindingSource ?? await localInstallationBindingSource(this.layout); }
  private file(source: InstallationBindingSource) {
    return new IdentityFile(this.layout, 'installationIdentity', {
      parse: value => installationIdentityRecordSchema.parse(value),
      create: async () => boundInstallationIdentitySchema.parse({ schemaVersion: 2, installationId: randomUUID(),
        binding: await source.capture(), lastResolution: null }),
      isError: (error: unknown) => error instanceof InstallationIdentityError,
      error: reason => new InstallationIdentityError(({ INVALID: 'INSTALLATION_IDENTITY_INVALID', UNAVAILABLE: 'INSTALLATION_IDENTITY_UNAVAILABLE',
        LOCKED: 'INSTALLATION_IDENTITY_LOCKED', UNSUPPORTED: 'INSTALLATION_IDENTITY_UNSUPPORTED' } as const)[reason]),
    }, this.lockTimeoutMs);
  }
  async loadOrCreate() {
    const source = await this.source(), record = await this.file(source).loadOrCreate();
    const binding = installationBindingSchema.parse(await source.capture());
    if (record.schemaVersion !== 2 || !matches(record.binding, binding)) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED');
    return installationIdentitySchema.parse({ schemaVersion: 1, installationId: record.installationId });
  }
  async resolveRelocation(choice: InstallationIdentityChoice, principal: { readonly issuer: string; readonly subject: string }) {
    if (!installationIdentityChoiceSchema.safeParse(choice).success) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
    const source = await this.source();
    const record = await this.file(source).update(async current => {
      const binding = installationBindingSchema.parse(await source.capture());
      // A second concurrent or repeated choice cannot silently rotate an already accepted identity.
      if (current.schemaVersion === 2 && matches(current.binding, binding)) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
      const installationId = choice === 'keep' ? current.installationId : randomUUID();
      const parsed = installationIdentityResolutionSchema.safeParse({ schemaVersion: 1, choice, previousInstallationId: current.installationId,
        installationId, at: new Date().toISOString(), principal });
      if (!parsed.success) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
      return boundInstallationIdentitySchema.parse({ schemaVersion: 2, installationId, binding, lastResolution: parsed.data });
    });
    if (record.schemaVersion !== 2 || !record.lastResolution) throw new InstallationIdentityError('INSTALLATION_IDENTITY_INVALID');
    return record.lastResolution;
  }
}
