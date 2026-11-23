import { REBIND_CLASS, delegationOwner, readableInstallationRegistrationSchema, type AttachmentPerson, type InstallationSource, type ReadableInstallationRegistration } from '#domain/index.js';
import { lstat } from 'node:fs/promises';
import { attachmentFailure, classifyInstallationRebinding, InstallationIdentityError, planSourceRepair, ProjectAttachmentRelocationApplication,
  type RegisteredInstallationBinding } from '#engine/index.js';
import { FileInstallationIdentityStore, FileProjectIdentityStore } from '#adapters/core/installation-files/index.js';
import type { ConfigLoadOptions, ResolvedConfig } from '#platform/index.js';
import { FileProjectAttachmentStore, captureAttachmentLocation } from './store.js';
import { localProjectAttachmentPorts } from './local.js';
import { readAttachmentBootstrapConfig } from './bootstrap.js';
import { relocateProjectAttachment } from './relocate.js';
type InspectSource = (root: string, scopeId: string, actor: AttachmentPerson, locked?: RegisteredInstallationBinding) => Promise<{ source: InstallationSource }>;
const exists = (path: string) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });

export async function relocateInstallationProjectReference(root: string, scopeId: string, options: ConfigLoadOptions, source: InspectSource, witnessed = false) {
  const config = await readAttachmentBootstrapConfig(root, options), store = new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
  const local = localProjectAttachmentPorts(config, options, store);
  return new ProjectAttachmentRelocationApplication({ config, store, actor: local.actor, authorize: local.authorize,
    location: () => captureAttachmentLocation(root), projectId: async () => { const project = await new FileProjectIdentityStore(root, config.configFile.writeLockTimeoutMs).read(); return project.status === 'available' ? project.value.projectId : null; },
    exists,
    publish: (before, after, settle) => relocateProjectAttachment(config, before, after, settle),
    reconcileSource: (registration, restore) => reconcileSource(config, store, registration, local.actor, source, restore ? 'restore' : 'person'),
  }).apply(scopeId, witnessed);
}

/** Called only from write entries after the target's principal/scope/reference checks. */
export async function repairRegisteredInstallationSource(config: ResolvedConfig, options: ConfigLoadOptions, actor: AttachmentPerson, scopeId: string,
  source: InspectSource, admit: () => Promise<void>) {
  const store = new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
  const matches = (record: ReadableInstallationRegistration | null): record is ReadableInstallationRegistration =>
    !!record && !record.unregistered && record.source.projectRoot === config.projectRoot && record.source.scopeId === scopeId
      && record.source.companyId === config.company.id && record.source.owner.issuer === delegationOwner(actor).issuer
      && record.source.owner.subject === delegationOwner(actor).subject;
  const observed = await store.registration().catch(() => null);
  if (!matches(observed) || await store.attachment()) return;
  if (observed.schemaVersion !== 3 || !observed.lineage) {
    const before = observed.source.location, current = await captureAttachmentLocation(config.productLayout.root).catch(() => null);
    // With no lineage, only a changed L1 source can take S1 or S2.
    if (!current || 'filesystemIdentity' in before || (before.canonicalRoot === current.canonicalRoot
      && before.inode === current.inode && before.device === current.device)) return;
  }
  await store.hold(async () => {
    const registration = await store.registration();
    if (!matches(registration) || await store.attachment()) return;
    await reconcileSource(config, store, registration, actor, source, 'automatic', admit);
  });
}

async function reconcileSource(config: ResolvedConfig, store: FileProjectAttachmentStore, registration: ReadableInstallationRegistration,
  actor: AttachmentPerson, inspect: InspectSource, mode: 'automatic' | 'restore' | 'person', admit?: () => Promise<void>) {
  const installation = new FileInstallationIdentityStore(config.productLayout, config.configFile.writeLockTimeoutMs, undefined, config.installation);
  return installation.withRegisteredBinding(actor, async locked => {
    const before = registration.source;
    if (locked.identity.installationId !== before.installationId) {
      if (mode === 'automatic') return;
      return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    }
    if (mode === 'automatic' && locked.outcome !== 'match'
      && (locked.outcome !== 'relocated' || classifyInstallationRebinding(locked.binding, locked.capture) !== REBIND_CLASS.deviceOnly)) return;
    if (mode === 'restore' && locked.outcome !== 'match'
      && classifyInstallationRebinding(locked.binding, locked.capture) !== REBIND_CLASS.deviceOnly)
      throw new InstallationIdentityError('INSTALLATION_IDENTITY_REBIND_REQUIRED');
    const { canonicalRoot, device, inode } = locked.capture;
    const expected = { ...before, location: { canonicalRoot, device, inode } };
    const planned = planSourceRepair(registration, locked, expected, candidate => store.fitsJoined(candidate));
    if (mode === 'automatic' && !planned) return;
    const { source } = await inspect(config.projectRoot, before.scopeId, actor, locked);
    if (source.projectId !== before.projectId || source.companyId !== before.companyId || source.scopeId !== before.scopeId
      || source.owner.issuer !== before.owner.issuer || source.owner.subject !== before.owner.subject) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    if (planned) {
      if (JSON.stringify(source) !== JSON.stringify(expected)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      await admit?.();
      await locked.commit(planned.kind, () => store.writeJoined(registration, planned.next));
    } else if (mode !== 'automatic') {
      // At a moved source, the old root and the retained binding's root both have to be absent.
      if (before.projectRoot !== source.projectRoot && await exists(before.projectRoot)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      if (locked.binding && locked.binding.canonicalRoot !== source.location.canonicalRoot && await exists(locked.binding.canonicalRoot))
        return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      const { lineage: ignored, ...retained } = { lineage: undefined, ...registration }; void ignored;
      const next = readableInstallationRegistrationSchema.parse({ ...retained, schemaVersion: 3, source });
      await locked.commit(locked.outcome === 'match' ? 'registration-only' : mode === 'restore' ? 'device-only' : 'person',
        () => store.writeJoined(registration, next));
    }
    return { schemaVersion: 1, status: 'relocated', installationId: before.installationId };
  });
}
