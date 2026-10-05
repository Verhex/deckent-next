import { randomUUID } from 'node:crypto';
import { boundInstallationIdentitySchema, installationBindingSchema, installationIdentityChoiceSchema, installationIdentityRecordSchema,
  installationIdentityResolutionSchema, installationIdentitySchema, type InstallationBinding, type InstallationIdentityChoice } from '#domain/index.js';
import { InstallationIdentityError, type InstallationIdentityStore, type InstallationBindingSource, type InstallationIdentityRead } from '#engine/index.js';
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
    private readonly bindingSource?: InstallationBindingSource,
    private readonly bindingLimits?: { readonly timeoutMs: number; readonly outputBytes: number }) {}
  private source() { return this.bindingSource ?? localInstallationBindingSource(this.layout, this.bindingLimits); }
  private file(source: InstallationBindingSource) {
    return new IdentityFile(this.layout, 'installationIdentity', {
      parse: value => installationIdentityRecordSchema.parse(value),
      create: async () => {
        const binding = await source.capture(), installationId = randomUUID();
        return 'status' in binding ? installationIdentitySchema.parse({ schemaVersion: 1, installationId })
          : boundInstallationIdentitySchema.parse({ schemaVersion: 2, installationId, binding, lastResolution: null });
      },
      isError: (error: unknown) => error instanceof InstallationIdentityError,
      error: reason => new InstallationIdentityError(({ INVALID: 'INSTALLATION_IDENTITY_INVALID', UNAVAILABLE: 'INSTALLATION_IDENTITY_UNAVAILABLE',
        LOCKED: 'INSTALLATION_IDENTITY_LOCKED', UNSUPPORTED: 'INSTALLATION_IDENTITY_UNSUPPORTED' } as const)[reason]),
    }, this.lockTimeoutMs);
  }
  private async validate(record: ReturnType<typeof installationIdentityRecordSchema.parse>, source: InstallationBindingSource) {
    const binding = await source.capture();
    if ('status' in binding) return 'unsupported' as const;
    if (record.schemaVersion !== 2 || !matches(record.binding, installationBindingSchema.parse(binding))) {
      throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED');
    }
    return 'supported' as const;
  }
  async read(): Promise<InstallationIdentityRead> {
    if (process.platform === 'win32' || this.layout.platform !== 'posix') {
      return { status: 'unavailable', reason: 'unsupported', bindingCapability: 'unsupported' };
    }
    const source = this.source(), record = await this.file(source).load();
    if (!record) return { status: 'unavailable', reason: 'not-created', bindingCapability: 'not-observed' };
    const bindingCapability = await this.validate(record, source);
    return { status: 'available', value: installationIdentitySchema.parse({ schemaVersion: 1, installationId: record.installationId }), bindingCapability };
  }
  async loadOrCreate() {
    const source = this.source(), record = await this.file(source).loadOrCreate();
    await this.validate(record, source);
    return installationIdentitySchema.parse({ schemaVersion: 1, installationId: record.installationId });
  }
  async resolveRelocation(choice: InstallationIdentityChoice, principal: { readonly issuer: string; readonly subject: string }) {
    if (!installationIdentityChoiceSchema.safeParse(choice).success) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
    const source = this.source();
    const record = await this.file(source).update(async current => {
      const captured = await source.capture();
      if ('status' in captured) throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNSUPPORTED');
      const binding = installationBindingSchema.parse(captured);
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
