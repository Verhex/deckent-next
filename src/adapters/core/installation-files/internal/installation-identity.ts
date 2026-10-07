import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { boundInstallationIdentitySchema, installationIdentityChoiceSchema, installationIdentityRecordSchema,
  installationIdentityResolutionSchema, installationIdentitySchema, retainedInstallationBinding, type InstallationBindingCapture, type InstallationIdentityChoice } from '#domain/index.js';
import { assessInstallationBinding, InstallationIdentityError, type InstallationBindingCapability, type InstallationIdentityStore,
  type InstallationBindingSource, type InstallationIdentityRead } from '#engine/index.js';
import type { ProductLayout } from '#platform/index.js';
import { IdentityFile } from './identity-file.js';
import { localInstallationBindingSource, type InstallationBindingSettings } from './installation-binding.js';

type IdentityRecord = ReturnType<typeof installationIdentityRecordSchema.parse>;
/** `bind`: an unbound v1 record on a host that can bind only weakly; the write path records the weak binding (reads never do). */
type Outcome = 'unsupported' | 'match' | 'bind' | 'strengthen' | 'relocated';
function assess(record: IdentityRecord, captured: InstallationBindingCapability): Outcome {
  if ('status' in captured) return 'unsupported';
  // A v1 record on a machine-capable host keeps the explicit-consent rule: it may be a copy from a host without machine identity.
  if (record.schemaVersion !== 2) return captured.strength === 'weak' ? 'bind' : 'relocated';
  return assessInstallationBinding(record.binding, captured);
}
const bound = (installationId: string, binding: InstallationBindingCapture, lastResolution: unknown) =>
  boundInstallationIdentitySchema.parse({ schemaVersion: 2, installationId, binding: retainedInstallationBinding(binding), lastResolution });
const identity = (record: IdentityRecord) => installationIdentitySchema.parse({ schemaVersion: 1, installationId: record.installationId });

/** One local metadata transition owner. Binding evidence detects relocation; it grants no authority. */
export class FileInstallationIdentityStore implements InstallationIdentityStore {
  constructor(private readonly layout: ProductLayout, private readonly lockTimeoutMs?: number,
    private readonly bindingSource?: InstallationBindingSource, private readonly settings: InstallationBindingSettings = {}) {}
  private source() { return this.bindingSource ?? localInstallationBindingSource(this.layout, this.settings); }
  /** Required machine binding refuses every installation-bound write without machine-strength evidence; reads only report it. */
  private requireMachine(captured: InstallationBindingCapability) {
    if (this.settings.requireMachineBinding && ('status' in captured || captured.strength !== 'machine')) {
      throw new InstallationIdentityError('INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED');
    }
  }
  /** First publication captures under the writer lock once the layout root exists, and refuses before the record directory is made. */
  private file(prepare: () => Promise<InstallationBindingCapability>) {
    return new IdentityFile<IdentityRecord, InstallationBindingCapability>(this.layout, 'installationIdentity', {
      parse: value => installationIdentityRecordSchema.parse(value),
      prepare,
      create: async captured => {
        const installationId = randomUUID(), binding = captured ?? await prepare();
        return 'status' in binding ? installationIdentitySchema.parse({ schemaVersion: 1, installationId }) : bound(installationId, binding, null);
      },
      isError: (error: unknown) => error instanceof InstallationIdentityError,
      error: reason => new InstallationIdentityError(({ INVALID: 'INSTALLATION_IDENTITY_INVALID', UNAVAILABLE: 'INSTALLATION_IDENTITY_UNAVAILABLE',
        LOCKED: 'INSTALLATION_IDENTITY_LOCKED', UNSUPPORTED: 'INSTALLATION_IDENTITY_UNSUPPORTED', MASKED: 'INSTALLATION_IDENTITY_MASKED' } as const)[reason]),
    }, this.lockTimeoutMs);
  }
  /** ID-1D: observes only. No identity, directory, lock or binding upgrade is created here; `pendingWrite` routes the next write. */
  async read(): Promise<InstallationIdentityRead> {
    if (process.platform === 'win32' || this.layout.platform !== 'posix') {
      return { status: 'unavailable', reason: 'unsupported', bindingCapability: 'unsupported' };
    }
    const source = this.source(), record = await this.file(() => source.capture()).load();
    if (!record) return { status: 'unavailable', reason: 'not-created', bindingCapability: 'not-observed' };
    const captured = await source.capture(), outcome = assess(record, captured);
    if (outcome === 'relocated') throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED');
    if ('status' in captured) return { status: 'available', value: identity(record), bindingCapability: 'unsupported' };
    const required = this.settings.requireMachineBinding === true && captured.strength !== 'machine';
    return { status: 'available', value: identity(record), bindingCapability: 'supported', binding: { strength: captured.strength, source: captured.source },
      ...(outcome === 'bind' || outcome === 'strengthen' || required ? { pendingWrite: true as const } : {}) };
  }
  /**
   * Owned-init preflight (init apply/resume, direct policy setup) before their first persistent effect: configured source validity,
   * relocation and required machine binding, with the same rules as the write path. ID-1D: observes only; no identity, directory, lock
   * or upgrade. Without a record the capability is probed at the nearest existing ancestor of the layout root (strength and source do
   * not depend on the location; the location is bound later, at first publication).
   */
  async admitWrite(): Promise<void> {
    if (process.platform === 'win32' || this.layout.platform !== 'posix') return this.requireMachine({ status: 'unsupported' });
    const record = await this.file(() => this.source().capture()).load();
    if (!record) {
      let root = this.layout.root;
      while (!(await stat(root).then(info => info.isDirectory(), () => false)) && dirname(root) !== root) root = dirname(root);
      return this.requireMachine(await (this.bindingSource ?? localInstallationBindingSource({ ...this.layout, root }, this.settings)).capture());
    }
    const captured = await this.source().capture();
    if (assess(record, captured) === 'relocated') throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED');
    this.requireMachine(captured);
  }
  /** Write path: first publication, v1 weak bind and weak-to-machine strengthening, each under the identity writer lock. */
  async loadOrCreate() {
    const source = this.source(); let prepared: InstallationBindingCapability | undefined;
    // A refused first use (required machine binding) stops before the record directory exists; nothing is left that reads as lost.
    const file = this.file(async () => { prepared = await source.capture(); this.requireMachine(prepared); return prepared; });
    const record = await file.loadOrCreate(), captured = prepared ?? await source.capture(), outcome = assess(record, captured);
    // Relocation first, as on the read path, so the operator sees the `--keep` / `--new` choice before the required-binding refusal.
    if (outcome === 'relocated') throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED');
    if (!prepared) this.requireMachine(captured);
    if (outcome !== 'bind' && outcome !== 'strengthen') return identity(record);
    // Re-capture and re-assess under the lock: a concurrent writer may already have recorded the binding, or the host may have changed.
    return identity(await file.update(async current => {
      const fresh = await source.capture(); this.requireMachine(fresh);
      const again = assess(current, fresh);
      if (again === 'relocated') throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED');
      if ((again !== 'bind' && again !== 'strengthen') || 'status' in fresh) return current;
      return bound(current.installationId, fresh, current.schemaVersion === 2 ? current.lastResolution : null);
    }));
  }
  async resolveRelocation(choice: InstallationIdentityChoice, principal: { readonly issuer: string; readonly subject: string }) {
    if (!installationIdentityChoiceSchema.safeParse(choice).success) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
    const source = this.source();
    const record = await this.file(() => source.capture()).update(async current => {
      const captured = await source.capture();
      if ('status' in captured) throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNSUPPORTED');
      this.requireMachine(captured); // `--keep` cannot bypass required machine binding by recording a weak one.
      // A second concurrent or repeated choice cannot silently rotate an already accepted identity.
      if (assess(current, captured) === 'match') throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
      const installationId = choice === 'keep' ? current.installationId : randomUUID();
      const parsed = installationIdentityResolutionSchema.safeParse({ schemaVersion: 1, choice, previousInstallationId: current.installationId,
        installationId, at: new Date().toISOString(), principal });
      if (!parsed.success) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
      return bound(installationId, captured, parsed.data);
    });
    if (record.schemaVersion !== 2 || !record.lastResolution) throw new InstallationIdentityError('INSTALLATION_IDENTITY_INVALID');
    return record.lastResolution;
  }
}
