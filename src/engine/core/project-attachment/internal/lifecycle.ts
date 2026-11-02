import { installationRegistrationSchema } from '#domain/index.js';
import type { AttachmentRegistryPort } from './application.js';
import type { ProjectAttachment, InstallationRegistration, AttachmentPerson, AttachmentLocation } from '#domain/index.js';
import { attachmentFailure, sameAttachmentPerson } from './context.js';
export function attachmentLifecycleIdentity(input: { registrationId: string; companyId: string; projectId: string | null;
  attachment: ProjectAttachment | null; registration: InstallationRegistration | null; actor: AttachmentPerson; location: AttachmentLocation }) {
  const { attachment, registration } = input, entry = registration?.entries.find(item => item.attachment.projectId === attachment?.projectId);
  if (!attachment || !registration || !entry || JSON.stringify(entry.attachment) !== JSON.stringify(attachment)
    || registration.registrationId !== input.registrationId || attachment.companyId !== input.companyId || input.projectId !== attachment.projectId
    || !sameAttachmentPerson(attachment.actor, input.actor) || JSON.stringify(input.location) !== JSON.stringify(attachment.location))
    return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  return registration.source.installationId;
}
export const settleRemovedAttachment = (store: AttachmentRegistryPort, registrationId: string, installationId: string, root: string) => store.hold(async () => {
  const current = await store.registration(); if (!current || current.registrationId !== registrationId || current.source.installationId !== installationId) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  const next = installationRegistrationSchema.parse({ ...current, entries: current.entries.map(entry => entry.attachment.location.canonicalRoot === root
    ? { ...entry, state: 'revoked', ...(entry.modelLease ? { modelLease: { ...entry.modelLease, state: 'revoked' } } : {}) } : entry) });
  await store.write(current, next);
});
