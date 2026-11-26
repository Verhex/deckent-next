import { installationRegistrationSchema, projectAttachmentSchema, isNewAttachmentRegistration, isNewAttachment, type ReadableInstallationRegistration, type ProjectAttachment, type AttachmentLocation, type AttachmentPerson } from '#domain/index.js';
import type { ResolvedConfig } from '#platform/index.js';
import type { AttachmentRegistryPort } from './application.js';
import { attachmentFailure, sameAttachmentPerson, sameProjectAttachmentAuthority } from './context.js';
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
