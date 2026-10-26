export { createBackupSet, verifyBackupSet, VerifiedBackup } from './internal/set.js';
export { FileBackupStorage, restoreLeftovers } from './internal/storage.js';
export { recordBackupAudit } from './internal/audit.js';
export type { BackupLimits, BackupState } from './internal/archive.js';
export { readBackupConfig, archivedConfigDocument } from './internal/archive.js';
export { inspectScheduledSets, pruneScheduledSets } from './internal/scheduled.js';
export { listBackupSets, lastBackupVerifications, type BackupSetEntry } from './internal/list.js';

export { createBackupCoverage, verifyBackupCoverage } from './internal/coverage.js';
export type { BackupCoverageRequest } from './internal/coverage.js';
export { FileTreeBackupOwner } from './internal/tree-owner.js';
export type { BackupTreeResource } from './internal/tree-owner.js';
