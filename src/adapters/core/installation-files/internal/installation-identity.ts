import { randomUUID } from 'node:crypto';
import { stat, open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { BEUSER_GENESIS_PATH, parseBeuserRealmSeal, assertUnsealedInstallation, type BeuserRealmSeal } from '#engine/index.js';
import { boundInstallationIdentitySchema, installationIdentityChoiceSchema, installationIdentityRecordSchema,
  installationIdentityResolutionSchema, installationIdentitySchema, retainedInstallationBinding, REBIND_CLASS, type RebindClass, type InstallationBinding } from '#domain/index.js';
import { assessInstallationBinding, classifyInstallationRebinding, InstallationIdentityError, PolicyAuthorizationError, ProjectAttachmentError, type RegisteredInstallationBinding, type InstallationIdentityResolutionInput, type RebindAdmission, type InstallationBindingCapability, type InstallationIdentityStore,
  type InstallationBindingSource, type InstallationIdentityRead } from '#engine/index.js';
import { productResourcePath, HOST_LIMITS_REGISTRY, sha256, type ProductLayout } from '#platform/index.js';
import { IdentityFile } from './identity-file.js';
import { localInstallationBindingSource, type InstallationBindingSettings } from './installation-binding.js';

type IdentityRecord = ReturnType<typeof installationIdentityRecordSchema.parse>;
/** `bind`: an unbound v1 record on a host that can bind only weakly; the write path records the weak binding (reads never do). */
type Outcome = 'unsupported' | 'match' | 'bind' | 'strengthen' | 'relocated';
function assess(record: IdentityRecord, captured: InstallationBindingCapability): Outcome {
  if ('status' in captured) return record.schemaVersion !== 1 && record.binding.schemaVersion === 3 ? 'relocated' : 'unsupported';
  // A v1 record on a machine-capable host keeps the explicit-consent rule: it may be a copy from a host without machine identity.
  if (record.schemaVersion === 1) return captured.strength === 'weak' ? 'bind' : 'relocated';
  return assessInstallationBinding(record.binding, captured);
}
const bound = (installationId: string, binding: InstallationBinding, lastResolution: unknown, realmSeal?: BeuserRealmSeal) =>
  realmSeal ? installationIdentityRecordSchema.parse({ schemaVersion: 3, installationId, binding, lastResolution, realmSeal })
    : boundInstallationIdentitySchema.parse({ schemaVersion: 2, installationId, binding, lastResolution });
const identity = (record: IdentityRecord) => installationIdentitySchema.parse({ schemaVersion: 1, installationId: record.installationId, ...('realmSeal' in record && record.realmSeal ? { realmSeal: record.realmSeal } : {}) });
const refuseNewerBindingWrite = (record: IdentityRecord | null) => {
  if (record && hasFilesystemBinding(record)) throw new InstallationIdentityError('INSTALLATION_IDENTITY_NEWER_BINDING');
};
const hasFilesystemBinding = (record: IdentityRecord) => record.schemaVersion !== 1 && record.binding.schemaVersion === 3;
function publishableBinding(capture: Exclude<InstallationBindingCapability, { status: 'unsupported' }>): InstallationBinding {
  const { filesystemIdentity } = capture;
  return capture.strength === 'machine' && filesystemIdentity
    ? { ...capture, schemaVersion: 3, filesystemIdentity } : retainedInstallationBinding(capture);
}
function upgradedBinding(record: IdentityRecord, captured: InstallationBindingCapability, outcome: Outcome): InstallationBinding | null {
  if (record.schemaVersion === 1 || hasFilesystemBinding(record) || (outcome !== 'match' && outcome !== 'strengthen')
    || 'status' in captured || captured.strength !== 'machine' || !captured.filesystemIdentity) return null;
  return publishableBinding(captured);
}

/** One local metadata transition owner. Binding evidence detects relocation; it grants no authority. */
export class FileInstallationIdentityStore implements InstallationIdentityStore {
  constructor(private readonly layout: ProductLayout, private readonly lockTimeoutMs?: number,
    private readonly bindingSource?: InstallationBindingSource, private readonly settings: InstallationBindingSettings = {},
    private readonly genesis: () => Promise<BeuserRealmSeal | undefined> = readBeuserGenesis) {}
  /** Trusted bootstrap provider only; never a CLI flag, environment switch or deserialized command. */
  private async checkSeal(record: IdentityRecord) {
    const genesis = await this.genesis();
    if (genesis && (!('realmSeal' in record) || JSON.stringify(record.realmSeal) !== JSON.stringify(genesis))) throw new InstallationIdentityError('INSTALLATION_IDENTITY_INVALID');
  }
  /** Read-only raw marker gate, before any ledger/key/target access. Forged or incomplete markers also refuse. */
  static async assertTransferAllowed(layout?: ProductLayout): Promise<void> {
    const genesis = await readBeuserGenesis();
    if (genesis) assertUnsealedInstallation({ realmSeal: genesis });
    if (!layout) return;
    const path = join(productResourcePath(layout, 'installationIdentity'), 'identity.json');
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > HOST_LIMITS_REGISTRY.processFileReadBytes) throw new InstallationIdentityError('INSTALLATION_IDENTITY_INVALID');
      assertUnsealedInstallation(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  }
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
      create: async binding => {
        if (!binding) throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNAVAILABLE');
        const installationId = randomUUID(), seal = await this.genesis();
        if ('status' in binding) {
          if (seal) throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNSUPPORTED');
          return installationIdentitySchema.parse({ schemaVersion: 1, installationId });
        }
        return bound(installationId, publishableBinding(binding), null, seal);
      },
      isError: (error: unknown) => error instanceof InstallationIdentityError || error instanceof ProjectAttachmentError || error instanceof PolicyAuthorizationError,
      error: reason => new InstallationIdentityError(({ INVALID: 'INSTALLATION_IDENTITY_INVALID', INCOMPLETE: 'INSTALLATION_IDENTITY_INVALID', UNAVAILABLE: 'INSTALLATION_IDENTITY_UNAVAILABLE',
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
    await this.checkSeal(record);
    const captured = await source.capture(), outcome = assess(record, captured);
    if (outcome === 'relocated') throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED');
    if ('status' in captured) return { status: 'available', value: identity(record), bindingCapability: 'unsupported' };
    const required = this.settings.requireMachineBinding === true && captured.strength !== 'machine';
    return { status: 'available', value: identity(record), bindingCapability: 'supported', binding: { strength: captured.strength, source: captured.source },
      ...(outcome === 'bind' || outcome === 'strengthen' || required ? { pendingWrite: true as const } : {}),
      ...(upgradedBinding(record, captured, outcome) ? { pendingUpgrade: true as const } : {}) };
  }
  /**
   * Owned-init preflight (init apply/resume, direct policy setup) before their first persistent effect: configured source validity,
   * relocation and required machine binding, with the same rules as the write path. ID-1D: observes only; no identity, directory, lock
   * or upgrade. Without a record the capability is probed at the nearest existing ancestor of the layout root (strength and source do
   * not depend on the location; the location is bound later, at first publication).
   */
  async admitWrite(): Promise<void> {
    await this.genesis();
    if (process.platform === 'win32' || this.layout.platform !== 'posix') return this.requireMachine({ status: 'unsupported' });
    const record = await this.file(() => this.source().capture()).load();
    if (!record) {
      let root = this.layout.root;
      while (!(await stat(root).then(info => info.isDirectory(), () => false)) && dirname(root) !== root) root = dirname(root);
      return this.requireMachine(await (this.bindingSource ?? localInstallationBindingSource({ ...this.layout, root }, this.settings)).capture());
    }
    await this.checkSeal(record);
    const captured = await this.source().capture();
    if (assess(record, captured) === 'relocated') throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED');
    this.requireMachine(captured);
  }
  /** Write path: first publication, v1 weak bind and weak-to-machine strengthening, each under the identity writer lock. */
  async loadOrCreate() {
    const source = this.source(); let prepared: InstallationBindingCapability | undefined;
    // A refused first use (required machine binding) stops before the record directory exists; nothing is left that reads as lost.
    const file = this.file(async () => { prepared = await source.capture(); this.requireMachine(prepared); return prepared; });
    const record = await file.loadOrCreate(); await this.checkSeal(record);
    const captured = prepared ?? await source.capture(), outcome = assess(record, captured);
    // Relocation first, as on the read path, so the operator sees the `--keep` / `--new` choice before the required-binding refusal.
    if (outcome === 'relocated') throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED');
    if (!prepared) this.requireMachine(captured);
    if (outcome !== 'bind' && outcome !== 'strengthen') return identity(record);
    // Re-capture and re-assess under the lock: a concurrent writer may already have recorded the binding, or the host may have changed.
    return identity(await file.update(async current => {
      await this.checkSeal(current);
      const fresh = await source.capture(); this.requireMachine(fresh);
      const again = assess(current, fresh);
      if (again === 'relocated') throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED');
      if ((again !== 'bind' && again !== 'strengthen') || 'status' in fresh || upgradedBinding(current, fresh, again)) return current;
      refuseNewerBindingWrite(current);
      return bound(current.installationId, retainedInstallationBinding(fresh), current.schemaVersion !== 1 ? current.lastResolution : null, 'realmSeal' in current ? current.realmSeal : undefined);
    }));
  }
  /** Only the caller that has made a positive write decision can take the retained upgrade path. */
  async upgradeAdmittedBinding(expectedId?: string) {
    const observed = await this.read();
    if (observed.status !== 'available') throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNAVAILABLE');
    if (expectedId !== undefined && observed.value.installationId !== expectedId) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
    if (!observed.pendingUpgrade) return observed.value;
    const source = this.source();
    return this.file(() => source.capture()).edit(async ({ current, retain, replace }) => {
      const record = current.record;
      await this.checkSeal(record);
      if (record.installationId !== observed.value.installationId) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
      const captured = await source.capture(), outcome = assess(record, captured);
      if (outcome === 'relocated') throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED');
      this.requireMachine(captured);
      const binding = upgradedBinding(record, captured, outcome);
      if (!binding || record.schemaVersion === 1) return identity(record);
      await retain();
      await replace(bound(record.installationId, binding, record.lastResolution, 'realmSeal' in record ? record.realmSeal : undefined));
      return identity(record);
    });
  }
  /** Managed rollback primitive. The recovery caller supplies held authority and the selected reader's compatibility proof. */
  async restorePreV3(proof: { readonly currentDigest: string; readonly preimageDigest: string;
    authorize(): Promise<void>; verifyReader(bytes: Buffer): Promise<boolean> }) {
    const source = this.source();
    return this.file(() => source.capture()).edit(async ({ current, companion, replace }) => {
      await proof.authorize();
      await this.checkSeal(current.record);
      const retained = await companion();
      if (!retained || !hasFilesystemBinding(current.record) || hasFilesystemBinding(retained.record)
        || identity(current.record).realmSeal || identity(retained.record).realmSeal || retained.record.installationId !== current.record.installationId
        || sha256(current.bytes) !== proof.currentDigest || sha256(retained.bytes) !== proof.preimageDigest
        || !await proof.verifyReader(Buffer.from(retained.bytes))) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
      await replace(retained.bytes);
      return identity(retained.record);
    });
  }
  /** The attachment writer holds registration custody for this entire callback. */
  async withRegisteredBinding<T>(principal: { readonly issuer: string; readonly subject: string }, work: (locked: RegisteredInstallationBinding) => Promise<T>) {
    const source = this.source();
    return this.file(() => source.capture()).edit(async ({ current: { record }, retain, replace, verify }) => {
      await this.checkSeal(record);
      const value = identity(record);
      if (value.realmSeal) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
      const capture = await source.capture();
      if ('status' in capture) throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNSUPPORTED');
      const outcome = assess(record, capture) as RegisteredInstallationBinding['outcome'];
      const binding = record.schemaVersion === 1 ? null : record.binding, candidate = publishableBinding(capture);
      return work({ identity: value, binding, capture, candidate, outcome, commit: async (kind, publishRegistration) => {
        await verify();
        this.requireMachine(capture);
        if (kind === 'registration-only') { await publishRegistration(); await verify(); return; }
        if (kind === 'device-only' && (outcome !== 'relocated' || classifyInstallationRebinding(binding, capture) !== REBIND_CLASS.deviceOnly))
          throw new InstallationIdentityError('INSTALLATION_IDENTITY_REBIND_REQUIRED');
        if (outcome === 'match') throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
        const resolution = kind === 'person' ? installationIdentityResolutionSchema.parse({ schemaVersion: 1, choice: 'keep',
          previousInstallationId: value.installationId, installationId: value.installationId, at: new Date().toISOString(), principal })
          : record.schemaVersion === 1 ? null : record.lastResolution;
        if (candidate.schemaVersion === 3 && !hasFilesystemBinding(record)) await retain();
        await replace(bound(value.installationId, candidate, resolution), publishRegistration);
      } });
    });
  }
  /** Gate preflight only; the writer repeats this comparison with a fresh capture under its lock. */
  inspectRebinding() { return this.inspectResolution(false); }

  inspectPlainRebinding() { return this.inspectResolution(true); }

  private async inspectResolution(plain: boolean) {
    const source = this.source(), record = await this.file(() => source.capture()).load();
    if (!plain) refuseNewerBindingWrite(record);
    if (!record) return { class: null, installationId: null };
    await this.checkSeal(record);
    const captured = await source.capture();
    if ('status' in captured) throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNSUPPORTED');
    this.requireMachine(captured);
    return { class: assess(record, captured) === 'relocated' ? classifyInstallationRebinding(record.schemaVersion === 1 ? null : record.binding, captured) : null,
      installationId: record.installationId };
  }
  resolveRelocation(input: InstallationIdentityResolutionInput, principal: { readonly issuer: string; readonly subject: string }) {
    return this.resolve(input, principal, false);
  }

  /** Explicit recovery with the caller's attachment lifecycle check repeated before publication. */
  resolvePlainRelocation(input: InstallationIdentityResolutionInput, principal: { readonly issuer: string; readonly subject: string }, assertPlain?: () => Promise<void>) {
    return this.resolve(input, principal, true, assertPlain);
  }

  private async resolve(input: InstallationIdentityResolutionInput, principal: { readonly issuer: string; readonly subject: string },
    plain: boolean, assertPlain?: () => Promise<void>) {
    const choice = input?.choice;
    if (!installationIdentityChoiceSchema.safeParse(choice).success) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
    const source = this.source();
    let change: RebindClass | null = null, basis: RebindAdmission['basis'] = 'open-class';
    // Refuse before creating a lock companion; repeat under the lock against a concurrent newer writer.
    const file = this.file(() => source.capture());
    if (!plain) refuseNewerBindingWrite(await file.load());
    const record = await file.edit(async ({ current: { record: current }, retain, replace }) => {
      await this.checkSeal(current);
      if (!plain) refuseNewerBindingWrite(current);
      if ('realmSeal' in current && current.realmSeal) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
      const captured = await source.capture();
      if ('status' in captured) throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNSUPPORTED');
      this.requireMachine(captured); // `--keep` cannot bypass required machine binding by recording a weak one.
      // A second concurrent or repeated choice cannot silently rotate an already accepted identity.
      const outcome = assess(current, captured);
      if (outcome === 'match') throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
      if (input.choice === 'keep' && outcome === 'relocated') {
        change = classifyInstallationRebinding(current.schemaVersion === 1 ? null : current.binding, captured);
        const admission = input.admission;
        if (!admission || (change === REBIND_CLASS.moved && admission.class !== REBIND_CLASS.moved))
          throw new InstallationIdentityError('INSTALLATION_IDENTITY_REBIND_REQUIRED');
        basis = admission.basis;
      }
      const installationId = choice === 'keep' ? current.installationId : randomUUID();
      const parsed = installationIdentityResolutionSchema.safeParse({ schemaVersion: 1, choice, previousInstallationId: current.installationId,
        installationId, at: new Date().toISOString(), principal });
      if (!parsed.success) throw new InstallationIdentityError('INSTALLATION_IDENTITY_RESOLUTION_INVALID');
      const binding = plain ? publishableBinding(captured) : retainedInstallationBinding(captured);
      await assertPlain?.();
      if (binding.schemaVersion === 3 && !hasFilesystemBinding(current)) await retain();
      const next = bound(installationId, binding, parsed.data);
      await replace(next, assertPlain);
      return next;
    });
    if (record.schemaVersion !== 2 || !record.lastResolution) throw new InstallationIdentityError('INSTALLATION_IDENTITY_INVALID');
    return { ...record.lastResolution, ...(choice === 'keep' ? { class: change, basis } : {}) };
  }
}

/** Only an exact read-only mount can mark a real init as sealed; a writable file or caller environment cannot. */
async function readBeuserGenesis(): Promise<BeuserRealmSeal | undefined> {
  let file;
  try { file = await open(BEUSER_GENESIS_PATH, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new InstallationIdentityError('INSTALLATION_IDENTITY_INVALID'); }
  try {
    const info = await file.stat(), mounts = await readFile('/proc/self/mountinfo', 'utf8');
    const mounted = mounts.split('\n').some(line => { const fields = line.split(' '); return fields[4] === BEUSER_GENESIS_PATH && fields[5]?.split(',').includes('ro'); });
    if (!mounted || !info.isFile() || info.nlink !== 1 || info.size > HOST_LIMITS_REGISTRY.processFileReadBytes || (info.mode & (constants.S_IWUSR | constants.S_IWGRP | constants.S_IWOTH))) throw new InstallationIdentityError('INSTALLATION_IDENTITY_INVALID');
    return parseBeuserRealmSeal(JSON.parse(await file.readFile('utf8')));
  } catch { throw new InstallationIdentityError('INSTALLATION_IDENTITY_INVALID'); }
  finally { await file.close(); }
}
