export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ attachmentPersonSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ attachmentLocationSchema, installationSourceSchema, projectAttachmentSchema, installationRegistrationSchema } from './internal/contract.js';
export type { AttachmentPerson, AttachmentLocation, InstallationSource, ProjectAttachment, InstallationRegistration } from './internal/contract.js';
export { projectAttachmentCommandSchema } from './internal/contract.js';
export type { ProjectAttachmentCommand } from './internal/contract.js';
export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ modelUseLeaseSchema } from './internal/contract.js';
export type { ModelUseLease } from './internal/contract.js';
export { attachmentPreparationSchema, projectAttachmentOfferSchema } from './internal/contract.js';
export type { AttachmentPreparation, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ProjectAttachmentOffer } from './internal/contract.js';

export { ATTACHMENT_REGISTRATION_VERSION, readableProjectAttachmentSchema, readableInstallationRegistrationSchema } from './internal/contract.js';
export type { ReadableProjectAttachment, ReadableInstallationRegistration, ReadableInstallationSource, ReadableAttachmentLocation } from './internal/contract.js';
export { assessAttachmentLocation, attachmentRegistrationAllowance, normalizeAttachmentRegistration, isNewAttachment, isNewAttachmentRegistration,
  isNewerAttachmentVersion, attachmentRevocationRecord, isAttachmentRevocationDiff, countMismatchedAttachments } from './internal/assessment.js';
export type { AttachmentRevocation } from './internal/assessment.js';
