import { assessAttachmentLocation, installationRegistrationSchema, isNewAttachmentRegistration, isNewAttachment } from '#domain/index.js';
import type { AttachmentRegistryPort } from './application.js';
import type { ReadableProjectAttachment as ProjectAttachment, ReadableInstallationRegistration as InstallationRegistration, AttachmentPerson, AttachmentLocation, FilesystemIdentity } from '#domain/index.js';
import { attachmentFailure, sameAttachmentPerson } from './context.js';
export function attachmentLifecycleIdentity(input: { registrationId: string; companyId: string; projectId: string | null;
  attachment: ProjectAttachment | null; registration: InstallationRegistration | null; actor: AttachmentPerson; location: AttachmentLocation & { filesystemIdentity?: FilesystemIdentity | null } }) {
  const { attachment, registration } = input, entry = registration?.entries.find(item => item.attachment.projectId === attachment?.projectId);
  if (!attachment || !registration || !entry || JSON.stringify(entry.attachment) !== JSON.stringify(attachment)
    || registration.registrationId !== input.registrationId || attachment.companyId !== input.companyId || input.projectId !== attachment.projectId
    || !sameAttachmentPerson(attachment.actor, input.actor) || !assessAttachmentLocation(attachment.location, input.location))
    return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  return registration.source.installationId;
}
export const settleRemovedAttachment = (store: AttachmentRegistryPort, registrationId: string, installationId: string, root: string) => store.hold(async () => {
  const current = await store.registration(); if (!current || current.registrationId !== registrationId || current.source.installationId !== installationId) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  if (isNewAttachmentRegistration(current) || isNewAttachment(await store.attachment?.())) return attachmentFailure('PROJECT_ATTACHMENT_NEWER_RECORD');
  const next = installationRegistrationSchema.parse({ ...current, entries: current.entries.map(entry => entry.attachment.location.canonicalRoot === root
    ? { ...entry, state: 'revoked', ...(entry.modelLease ? { modelLease: { ...entry.modelLease, state: 'revoked' } } : {}) } : entry) });
  await store.write(current, next);
});

/** Observation only; shared by mutation admission and the terminal's optional directory preparation. */
export async function attachmentMutationFenced(store: Pick<AttachmentRegistryPort, 'registration' | 'attachment'>) {
  return isNewAttachmentRegistration(await store.registration()) || isNewAttachment(await store.attachment?.());
}
