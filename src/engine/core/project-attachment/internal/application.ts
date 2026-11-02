import { createHash, randomUUID } from 'node:crypto';
import { installationRegistrationSchema, projectAttachmentSchema, identitySchema, persistedUuid, type InstallationRegistration, type InstallationSource,
  type ProjectAttachment, type AttachmentLocation, type AttachmentPerson } from '#domain/index.js';
import { attachmentFailure, existingSharedIdentity, sameAttachmentPerson } from './context.js';
import type { InstallationIdentityRead } from '#engine/core/bootstrap-identity/index.js';

export interface AttachmentRegistryPort {
  registration(): Promise<InstallationRegistration | null>;
  hold<T>(work: () => Promise<T>): Promise<T>;
  write(expected: InstallationRegistration | null, next: InstallationRegistration): Promise<void>;
}
export interface ProjectAttachmentPorts {
  readonly store: AttachmentRegistryPort;
  readonly actor: AttachmentPerson;
  authorize(): Promise<void>;
  source(root: string, scopeId: string, actor: AttachmentPerson): Promise<{ readonly source: InstallationSource; readonly identity: InstallationIdentityRead }>;
  target(): Promise<{ readonly location: AttachmentLocation; readonly projectId: string | null; readonly companyId: string; readonly configDigest: string }>;
  ensureProject(projectId: string): Promise<void>;
  install(attachment: ProjectAttachment, identity: () => Promise<InstallationIdentityRead>): Promise<unknown>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Inventory and project journal are separate settlements. Pending inventory never authorizes a session. */
export class ProjectAttachmentApplication {
  constructor(private readonly ports: ProjectAttachmentPorts) {}
  private async currentSource(registration: InstallationRegistration) {
    if (!sameAttachmentPerson(registration.source.owner, this.ports.actor)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
    const observed = await this.ports.source(registration.source.projectRoot, registration.source.scopeId, this.ports.actor).catch(() => attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE'));
    if (JSON.stringify(observed.source) !== JSON.stringify(registration.source)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    existingSharedIdentity(observed.identity);
    return observed.identity;
  }
  async registrationPreview(root: string, scopeId: string) {
    const observed = await this.ports.source(root, scopeId, this.ports.actor);
    existingSharedIdentity(observed.identity);
    const current = await this.ports.store.registration();
    if (current && JSON.stringify(current.source) !== JSON.stringify(observed.source)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    return Object.freeze({ schemaVersion: 1 as const, status: 'preview' as const, source: observed.source,
      planDigest: digest({ operation: 'installation.register.v1', source: observed.source, current }) });
  }
  async register(root: string, scopeId: string, expect: string) {
    await this.ports.authorize();
    // Refuse invalid source before creating the global lock or state directory.
    const preview = await this.registrationPreview(root, scopeId);
    if (preview.planDigest !== expect) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    return this.ports.store.hold(async () => {
      const currentPreview = await this.registrationPreview(root, scopeId);
      if (currentPreview.planDigest !== expect) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      const current = await this.ports.store.registration();
      if (current) return current;
      const next = installationRegistrationSchema.parse({ schemaVersion: 1, registrationId: randomUUID(), source: preview.source, entries: [] });
      await this.ports.store.write(null, next); return next;
    });
  }
  async preview(scopeId: string) {
    identitySchema.parse(scopeId);
    const registration = await this.ports.store.registration();
    if (!registration) return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
    await this.currentSource(registration);
    const target = await this.ports.target();
    if (target.location.canonicalRoot === registration.source.projectRoot || target.companyId !== registration.source.companyId) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
    return Object.freeze({ schemaVersion: 1 as const, status: 'preview' as const, scopeId, actor: this.ports.actor,
      registrationId: registration.registrationId, source: registration.source, target,
      planDigest: digest({ operation: 'project.attach.v1', registration, target, scopeId, actor: this.ports.actor }) });
  }
  async apply(scopeId: string, expect: string, commandId: string) {
    persistedUuid().parse(commandId);
    if (!/^[a-f0-9]{64}$/.test(expect)) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
    await this.ports.authorize();
    const initial = await this.preview(scopeId);
    const resume = (await this.ports.store.registration())?.entries.find(item => item.attachment.commandId === commandId);
    if (!resume && initial.planDigest !== expect) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    return this.ports.store.hold(async () => {
      let registration = await this.ports.store.registration();
      if (!registration) return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
      const current = await this.preview(scopeId);
      let entry = registration.entries.find(item => item.attachment.commandId === commandId);
      if (entry) {
        if (entry.planDigest !== expect || entry.attachment.scopeId !== scopeId || !sameAttachmentPerson(entry.attachment.actor, this.ports.actor)
          || JSON.stringify(entry.attachment.location) !== JSON.stringify(current.target.location)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
        if (entry.state === 'revoked') return attachmentFailure('PROJECT_ATTACHMENT_REVOKED');
      } else {
        if (current.planDigest !== expect || registration.entries.some(item => item.attachment.location.canonicalRoot === current.target.location.canonicalRoot)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
        entry = { attachment: projectAttachmentSchema.parse({ schemaVersion: 1, registrationId: registration.registrationId,
          projectId: current.target.projectId ?? randomUUID(), companyId: registration.source.companyId, scopeId, actor: this.ports.actor,
          location: current.target.location, commandId }), planDigest: expect, state: 'pending' as const };
        const next = installationRegistrationSchema.parse({ ...registration, entries: [...registration.entries, entry] });
        await this.ports.store.write(registration, next); registration = next;
      }
      const attachment = entry.attachment;
      await this.ports.ensureProject(attachment.projectId);
      await this.currentSource(registration);
      const result = await this.ports.install(attachment, () => this.currentSource(registration!));
      await this.currentSource(registration);
      if (entry.state !== 'active') {
        await this.ports.store.write(registration, installationRegistrationSchema.parse({ ...registration,
          entries: registration.entries.map(item => item.attachment.projectId === attachment.projectId ? { ...item, state: 'active' } : item) }));
      }
      return Object.freeze({ schemaVersion: 1 as const, status: 'attached' as const, attachment, installationId: registration.source.installationId, result });
    });
  }
  async revoke(projectId: string) {
    await this.ports.authorize();
    return this.ports.store.hold(async () => {
      const current = await this.ports.store.registration();
      if (!current) return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
      await this.currentSource(current);
      if (!current.entries.some(item => item.attachment.projectId === projectId)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
      const next = installationRegistrationSchema.parse({ ...current, entries: current.entries.map(item => item.attachment.projectId === projectId ? { ...item, state: 'revoked' } : item) });
      await this.ports.store.write(current, next); return { schemaVersion: 1 as const, status: 'revoked' as const, projectId };
    });
  }
}
