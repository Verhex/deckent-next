import { readableProjectAttachmentSchema, isNewAttachmentRegistration, isNewAttachment, isNewerAttachmentVersion, type ReadableInstallationRegistration as InstallationRegistration, type AttachmentPerson } from '#domain/index.js';
import { attachmentFailure, sameAttachmentPerson, sameProjectAttachmentAuthority } from './context.js';
interface SharedBackupState { readonly schemaVersion: number; readonly sharedRegistrationId?: string; readonly installationId: string;
  readonly entries: readonly { resource: string; path: string; content: string }[] }
interface AttachmentRestorePorts { readonly actor: AttachmentPerson; registration(): Promise<InstallationRegistration | null>;
  exists(path: string): Promise<boolean>; projectId(path: string): Promise<string | null> }
/** The authenticated set restores one recorded project, never an authority copied from a surviving folder. */
export async function verifySharedAttachmentRestore(config: { company: { id: string } }, state: SharedBackupState, destination: string, scopeId: string, ports: AttachmentRestorePorts) {
  if (state.schemaVersion !== 3) return false;
  const item = state.entries.find(entry => entry.resource === 'projectAttachment' && entry.path === '');
  if (!item) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(item.content, 'base64').toString('utf8')); } catch { return attachmentFailure('PROJECT_ATTACHMENT_INVALID'); }
  if (isNewerAttachmentVersion(raw, 2)) return attachmentFailure('PROJECT_ATTACHMENT_NEWER_RECORD');
  const parsed = readableProjectAttachmentSchema.safeParse(raw);
  if (!parsed.success) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  const reference = parsed.data;
  const registry = await ports.registration(), entry = registry?.entries.find(row => row.attachment.projectId === reference.projectId);
  if (isNewAttachment(reference) || isNewAttachmentRegistration(registry)) return attachmentFailure('PROJECT_ATTACHMENT_NEWER_RECORD');
  if (!registry || !entry || registry.registrationId !== state.sharedRegistrationId || registry.source.installationId !== state.installationId
    || reference.scopeId !== scopeId || reference.companyId !== config.company.id || !sameAttachmentPerson(reference.actor, ports.actor)
    || !sameProjectAttachmentAuthority(entry.attachment, reference)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  const oldRoot = entry.attachment.location.canonicalRoot;
  if (destination !== oldRoot && await ports.exists(oldRoot)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  const projectId = await ports.projectId(destination);
  if (projectId !== null && projectId !== reference.projectId) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  return true;
}
