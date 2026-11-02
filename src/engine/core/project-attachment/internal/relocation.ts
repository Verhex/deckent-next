import { installationRegistrationSchema, type InstallationSource, type ProjectAttachment, type AttachmentLocation, type AttachmentPerson } from '#domain/index.js';
import type { ResolvedConfig } from '#platform/index.js';
import type { AttachmentRegistryPort } from './application.js';
import { attachmentFailure, sameAttachmentPerson, sameProjectAttachmentAuthority } from './context.js';
export interface AttachmentRelocationPorts {
  readonly config: ResolvedConfig; readonly store: AttachmentRegistryPort & { attachment(): Promise<ProjectAttachment | null> }; readonly actor: AttachmentPerson;
  authorize(): Promise<void>; location(): Promise<AttachmentLocation>; projectId(): Promise<string | null>; exists(root: string): Promise<boolean>;
  keepIdentity(): Promise<string>; source(root: string, scopeId: string, actor: AttachmentPerson): Promise<{ source: InstallationSource }>;
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
      if (reference) {
        const entry = registry.entries.find(item => item.attachment.projectId === reference.projectId);
        if (!entry || reference.scopeId !== scopeId || config.installation.sharedRegistrationId !== registry.registrationId
          || reference.companyId !== config.company.id || !sameAttachmentPerson(reference.actor, actor) || await this.ports.projectId() !== reference.projectId)
          return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
        const before = entry.attachment, location = await this.ports.location(), next: ProjectAttachment = { ...before, location };
        if (before.location.canonicalRoot !== location.canonicalRoot && await this.ports.exists(before.location.canonicalRoot)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
        const historical = JSON.stringify(reference) !== JSON.stringify(before) && JSON.stringify(reference) !== JSON.stringify(next);
        if (historical && (!witnessed || !sameProjectAttachmentAuthority(reference, before))) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
        return this.ports.publish(historical ? reference : before, next, () => store.write(registry, installationRegistrationSchema.parse({ ...registry,
          entries: registry.entries.map(item => item === entry ? { ...item, attachment: next } : item) })));
      }
      if (config.installation.sharedRegistrationId || scopeId !== registry.source.scopeId) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
      if (registry.source.projectRoot !== config.projectRoot && await this.ports.exists(registry.source.projectRoot)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      if (await this.ports.keepIdentity() !== registry.source.installationId) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      const observed = await this.ports.source(config.projectRoot, scopeId, actor);
      if (observed.source.installationId !== registry.source.installationId || observed.source.projectId !== registry.source.projectId || observed.source.companyId !== registry.source.companyId)
        return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      await store.write(registry, installationRegistrationSchema.parse({ ...registry, source: observed.source }));
      return { schemaVersion: 1, status: 'relocated', installationId: registry.source.installationId };
    });
  }
}
