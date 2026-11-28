import { isDeepStrictEqual } from 'node:util';
import { assessAttachmentLocation, installationRegistrationSchema, projectAttachmentSchema, readableInstallationRegistrationSchema, readableProjectAttachmentSchema,
  isNewAttachmentRegistration, isNewAttachment, type ReadableInstallationRegistration, type ProjectAttachment, type AttachmentLocation, type AttachmentPerson,
  type ReadableInstallationSource, type ReadableProjectAttachment, type FilesystemIdentity } from '#domain/index.js';
import type { ResolvedConfig } from '#platform/index.js';
import type { RegisteredInstallationBinding } from '#engine/core/bootstrap-identity/index.js';
import type { AttachmentRegistryPort } from './application.js';
import { attachmentFailure, sameAttachmentPerson, sameProjectAttachmentAuthority } from './context.js';
import { bindingKey } from './source-repair.js';
/** The device numbers the target repair reads and writes; the first-publication witness shares it, so the two cannot drift. */
const decimalDevice = /^\d{1,20}$/u;
/** The exact text a repair writes as a NEW device: String() of the bigint stat device (adapters store.ts:32), i.e. canonical decimal below 2^64. */
const writtenDevice = (device: string) => /^(0|[1-9]\d*)$/u.test(device) && BigInt(device) < 2n ** 64n;

export function planTargetRepair(registration: ReadableInstallationRegistration, local: ReadableProjectAttachment,
  identity: Pick<RegisteredInstallationBinding, 'binding' | 'capture' | 'outcome' | 'identity'>, source: ReadableInstallationSource,
  target: AttachmentLocation & { readonly projectId: string | null; readonly filesystemIdentity: FilesystemIdentity | null },
  fits: (reference: ReadableProjectAttachment, registration: ReadableInstallationRegistration) => boolean) {
  const lineage = registration.schemaVersion === 3 ? registration.lineage : undefined;
  const entry = registration.entries.find(item => item.attachment.projectId === local.projectId);
  if (!lineage || !entry || entry.state !== 'active' || registration.unregistered || !identity.binding || identity.outcome !== 'match'
    || identity.identity.installationId !== registration.source.installationId || identity.identity.realmSeal
    || lineage.toBinding !== bindingKey(identity.binding) || target.projectId !== local.projectId
    || !sameProjectAttachmentAuthority(entry.attachment, local)) return null;
  const { location: retainedSource, ...expected } = registration.source, { location: freshSource, ...observed } = source;
  const filesystemIdentity = lineage.filesystemIdentity;
  if (!isDeepStrictEqual(expected, observed)
    || !assessAttachmentLocation(retainedSource, { ...freshSource, filesystemIdentity: identity.capture.filesystemIdentity ?? null })
    || (filesystemIdentity !== null && (!isDeepStrictEqual(filesystemIdentity, identity.capture.filesystemIdentity)
      || !isDeepStrictEqual(filesystemIdentity, target.filesystemIdentity)))
    || (filesystemIdentity === null && target.device !== lineage.headDevice)) return null;

  const { canonicalRoot, device, inode } = target, previous = entry.attachment;
  if (previous.location.canonicalRoot !== canonicalRoot || previous.location.inode !== inode || !decimalDevice.test(device)
    || (previous.schemaVersion === 1 && !decimalDevice.test(previous.location.device))) return null;
  if (assessAttachmentLocation(previous.location, target)) {
    if (!fits(previous, registration)) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
    return { attachment: previous, registration: null, operationId: lineage.headIntentId };
  }
  const proved = new Set([...lineage.pastDevices, lineage.headDevice, identity.binding.device]);
  if (previous.schemaVersion !== 1 || !proved.has(previous.location.device)) return null;

  const candidate = (attachment: ReadableProjectAttachment) => {
    const entries = registration.entries.map(item => item === entry ? { ...item, attachment } : item);
    const referenced = new Set(entries.map(item => item.attachment.location.device));
    const devices = attachment.schemaVersion === 1 ? [...proved, device] : [...proved];
    const pastDevices = [...new Set(devices)].filter(value => value !== lineage.headDevice && decimalDevice.test(value) && referenced.has(value));
    const next = readableInstallationRegistrationSchema.parse({ ...registration, entries, lineage: { ...lineage, pastDevices } });
    return { attachment, registration: next, operationId: lineage.headIntentId };
  };
  const location = { canonicalRoot, device, inode };
  if (filesystemIdentity) {
    const stronger = candidate(readableProjectAttachmentSchema.parse({ ...previous, schemaVersion: 2, location: { ...location, filesystemIdentity } }));
    if (fits(stronger.attachment, stronger.registration)) return stronger;
  }
  const fallback = candidate(projectAttachmentSchema.parse({ ...previous, location }));
  return fits(fallback.attachment, fallback.registration) ? fallback : attachmentFailure('PROJECT_ATTACHMENT_INVALID');
}
/** Owner K1 (A3): the on-disk digests at which the verified current reference still witnesses the first publication's. The original bytes of
 * that reference stay accepted as they are; the repair writer's exact output only for a reference planTargetRepair can produce from it: same
 * authority, root and inode, from a v1 record with a decimal device, a changed reference only with a device text the repair writes (writtenDevice);
 * a v2 record it only rewrites unchanged. The bytes are the evidence: a different text of the same number is not normalised. */
export function firstPublicationReferenceDigests(first: ReadableProjectAttachment, current: ReadableProjectAttachment, digests: { readonly original: string; readonly written: string }): readonly string[] {
  if (!sameProjectAttachmentAuthority(first, current) || first.location.canonicalRoot !== current.location.canonicalRoot
    || first.location.inode !== current.location.inode) return [];
  const same = isDeepStrictEqual(first, current), writable = first.schemaVersion === 2 ? same : decimalDevice.test(first.location.device) && (same || writtenDevice(current.location.device));
  return [...(same ? [digests.original] : []), ...(writable ? [digests.written] : [])];
}
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export interface AttachmentRelocationPorts {
  readonly config: ResolvedConfig; readonly store: AttachmentRegistryPort & { attachment(): Promise<import('#domain/index.js').ReadableProjectAttachment | null> }; readonly actor: AttachmentPerson;
  authorize(): Promise<void>; location(): Promise<AttachmentLocation>; projectId(): Promise<string | null>; exists(root: string): Promise<boolean>;
  reconcileSource(registry: ReadableInstallationRegistration, witnessed: boolean): Promise<unknown>;
  publish(before: ProjectAttachment, after: ProjectAttachment, settle: () => Promise<void>): Promise<unknown>;
}
/** A live old root is a copy, never an implicit move. Reconciliation retains the installation and project identities. */
export class ProjectAttachmentRelocationApplication {
  constructor(private readonly ports: AttachmentRelocationPorts) {}
  async apply(scopeId: string, witnessed = false) {
    const { config, store, actor } = this.ports; if (!witnessed) await this.ports.authorize();
    return store.hold(async () => {
      const registry = await store.registration();
      if (!registry || !sameAttachmentPerson(registry.source.owner, actor)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
      const reference = await store.attachment();
      if (isNewAttachment(reference) || (isNewAttachmentRegistration(registry) && (reference || witnessed))) return attachmentFailure('PROJECT_ATTACHMENT_NEWER_RECORD');
      if (reference) {
        const entry = registry.entries.find(item => item.attachment.projectId === reference.projectId);
        if (!entry || reference.scopeId !== scopeId || config.installation.sharedRegistrationId !== registry.registrationId
          || reference.companyId !== config.company.id || !sameAttachmentPerson(reference.actor, actor) || await this.ports.projectId() !== reference.projectId)
          return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
        const before = projectAttachmentSchema.parse(entry.attachment), location = await this.ports.location(), next: ProjectAttachment = { ...before, location };
        if (before.location.canonicalRoot !== location.canonicalRoot && await this.ports.exists(before.location.canonicalRoot)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
        const historical = JSON.stringify(reference) !== JSON.stringify(before) && JSON.stringify(reference) !== JSON.stringify(next);
        if (historical && (!witnessed || !sameProjectAttachmentAuthority(reference, before))) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
        return this.ports.publish(historical ? projectAttachmentSchema.parse(reference) : before, next, () => store.write(registry, installationRegistrationSchema.parse({ ...registry,
          entries: registry.entries.map(item => item === entry ? { ...item, attachment: next } : item) })));
      }
      if (config.installation.sharedRegistrationId || scopeId !== registry.source.scopeId) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
      if (registry.source.projectRoot !== config.projectRoot && await this.ports.exists(registry.source.projectRoot)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      return this.ports.reconcileSource(registry, witnessed);
    });
  }
}
