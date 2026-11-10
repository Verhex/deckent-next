export { FileProjectAttachmentStore, captureAttachmentLocation, prepareAttachmentDirectory } from './internal/store.js';
export { localProjectAttachmentPorts } from './internal/local.js';
export { attachmentLifecycle, attachmentGuardedBackupStorage } from './internal/lifecycle.js';
export { readAttachmentBootstrapConfig } from './internal/bootstrap.js';
export { relocateProjectAttachment } from './internal/relocate.js';
export { relocateInstallationProjectReference } from './internal/relocation.js';
export { verifySharedProjectRestore } from './internal/restore.js';
export { inspectInstallationSourceFiles, localInstallationProjectContextPorts } from './internal/context.js';
export { settleAttachmentRemoval } from './internal/removal.js';
