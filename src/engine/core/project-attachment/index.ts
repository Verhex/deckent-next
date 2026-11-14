export { ProjectAttachmentError, attachmentFailure, sameAttachmentPerson, resolveInstallationProjectContext, existingSharedIdentity } from './internal/context.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ProjectAttachmentErrorCode, InstallationContextPorts, InstallationProjectContext } from './internal/context.js';
export { ProjectAttachmentApplication } from './internal/application.js';
export type { ProjectAttachmentPorts, AttachmentRegistryPort } from './internal/application.js';
export { ProjectAttachmentRelocationApplication } from './internal/relocation.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AttachmentRelocationPorts } from './internal/relocation.js';
export { attachmentLifecycleIdentity, settleRemovedAttachment, attachmentMutationFenced } from './internal/lifecycle.js';
export { verifySharedAttachmentRestore } from './internal/restore.js';
