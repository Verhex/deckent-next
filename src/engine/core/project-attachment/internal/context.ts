import { CodedError } from '#platform/index.js';
import { isDeepStrictEqual } from 'node:util';
import { delegationOwner, installationRegistrationSchema, projectAttachmentSchema, type AttachmentPerson, type InstallationRegistration, type InstallationSource,
  type ProjectAttachment, type InstallationIdentity } from '#domain/index.js';
import type { InstallationIdentityRead } from '#engine/core/bootstrap-identity/index.js';

export type ProjectAttachmentErrorCode = 'PROJECT_ATTACHMENT_INVALID' | 'PROJECT_ATTACHMENT_UNAVAILABLE' | 'PROJECT_ATTACHMENT_CHANGED'
  | 'PROJECT_ATTACHMENT_DENIED' | 'PROJECT_ATTACHMENT_REVOKED' | 'PROJECT_ATTACHMENT_INCOMPLETE' | 'PROJECT_ATTACHMENT_LIFECYCLE_BLOCKED' | 'PROJECT_ATTACHMENT_SOURCE_REGISTERED'
  | 'PROJECT_ATTACHMENT_PERSON_MISMATCH' | 'MODEL_USE_NOT_ACTIVE' | 'MODEL_USE_BINDING_CHANGED';
export class ProjectAttachmentError extends CodedError {
  constructor(override readonly code: ProjectAttachmentErrorCode) { super(code); this.name = 'ProjectAttachmentError'; }
}
export const attachmentFailure = (code: ProjectAttachmentErrorCode): never => { throw new ProjectAttachmentError(code); };
export const sameAttachmentPerson = (a: AttachmentPerson, b: AttachmentPerson) => a.issuer === b.issuer && a.subject === b.subject;
export interface InstallationContextPorts {
  registration(): Promise<InstallationRegistration | null>;
  attachment(): Promise<ProjectAttachment | null>;
  source(source: InstallationSource): Promise<{ readonly identity: InstallationIdentityRead; readonly source: InstallationSource }>;
  target(): Promise<{ readonly canonicalRoot: string; readonly device: string; readonly inode: string; readonly projectId: string | null }>;
  legacy(): Promise<InstallationIdentityRead>;
}
export interface InstallationProjectContext {
  readonly kind: 'legacy' | 'attached'; readonly identity: InstallationIdentityRead;
  readonly source: InstallationSource | null; readonly attachment: ProjectAttachment | null;
}
/** A reference never bootstraps or strengthens an identity. Every access revalidates both retained locations and revocation. */
export async function resolveInstallationProjectContext(ports: InstallationContextPorts,
  request: { readonly registrationId: string | null; readonly companyId: string; readonly scopeId?: string; readonly actor?: AttachmentPerson }): Promise<InstallationProjectContext> {
  const raw = await ports.attachment();
  if (!request.registrationId) {
    if (raw) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
    return Object.freeze({ kind: 'legacy', identity: await ports.legacy(), source: null, attachment: null });
  }
  if (!raw) return attachmentFailure('PROJECT_ATTACHMENT_INCOMPLETE');
  const attachment = projectAttachmentSchema.parse(raw), registry = await ports.registration();
  if (!registry || registry.unregistered) return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
  const registration = installationRegistrationSchema.parse(registry);
  if (registration.registrationId !== request.registrationId || attachment.registrationId !== registration.registrationId
    || request.companyId !== registration.source.companyId || attachment.companyId !== request.companyId
    || (request.scopeId !== undefined && attachment.scopeId !== request.scopeId)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  // A workload (the MCP channel of a native chat turn) is held to the person it acts for; source scope membership still checks the workload itself.
  if (request.actor !== undefined && !sameAttachmentPerson(attachment.actor, delegationOwner(request.actor))) return attachmentFailure('PROJECT_ATTACHMENT_PERSON_MISMATCH');
  const entry = registration.entries.find(item => item.attachment.projectId === attachment.projectId);
  if (!entry || JSON.stringify(entry.attachment) !== JSON.stringify(attachment)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  if (entry.state === 'revoked') return attachmentFailure('PROJECT_ATTACHMENT_REVOKED');
  if (entry.state !== 'active') return attachmentFailure('PROJECT_ATTACHMENT_INCOMPLETE');
  const target = await ports.target();
  if (target.projectId !== attachment.projectId || target.canonicalRoot !== attachment.location.canonicalRoot
    || target.device !== attachment.location.device || target.inode !== attachment.location.inode) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  const observed = await ports.source(registration.source).catch(() => attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE'));
  if (JSON.stringify(observed.source) !== JSON.stringify(registration.source) || observed.identity.status !== 'available'
    || observed.identity.pendingWrite || observed.identity.value.installationId !== registration.source.installationId
    || observed.identity.value.realmSeal) return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
  return Object.freeze({ kind: 'attached', identity: observed.identity, source: registration.source, attachment });
}
/** Only the existing identity is returned; losing the reference target never creates a replacement. */
export function existingSharedIdentity(identity: InstallationIdentityRead): InstallationIdentity {
  if (identity.status !== 'available' || identity.pendingWrite || identity.value.realmSeal) return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
  return identity.value;
}

/** Location changes only through witnessed relocation; every authority identity remains exact. */
export function sameProjectAttachmentAuthority(left: ProjectAttachment, right: ProjectAttachment) {
  const { location: ignoredLeft, ...a } = left, { location: ignoredRight, ...b } = right; void ignoredLeft; void ignoredRight; return isDeepStrictEqual(a, b);
}
