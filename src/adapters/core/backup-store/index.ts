export { createBackupSet, currentSetDigest, verifyBackupSet, VerifiedBackup } from './internal/set.js';
export { FileBackupStorage, restoreLeftovers } from './internal/storage.js';
export { recordBackupAudit, BACKUP_AUDIT_LOCATIONS } from './internal/audit.js';
export type { BackupLimits, BackupState } from './internal/archive.js';
export { readBackupConfig, archivedConfigDocument, BACKUP_RESOURCES } from './internal/archive.js';
export { ledgerFingerprint } from './internal/fingerprint.js';
export { inspectScheduledSets, pruneScheduledSets } from './internal/scheduled.js';
export { listBackupSets, lastBackupVerifications, type BackupSetEntry } from './internal/list.js';

export { createBackupCoverage, verifyBackupCoverage } from './internal/coverage.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ BackupCoverageRequest } from './internal/coverage.js';
export { digestFile } from './internal/files.js';
