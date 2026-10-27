export { InstallationCacheRemovalTarget } from './internal/cache.js';
export type { CacheRemovalResource, CacheRemovalBounds } from './internal/cache.js';

export { UninstallRecovery } from './internal/recovery.js';
export { nativeServiceExec, type NativeServiceExec } from './internal/native-service.js';
export { InstallationDataRemovalTarget } from './internal/data.js';
export type { DataRemovalMember, DataRemovalSnapshot } from './internal/data.js';
export { extendUninstallInventory, uninstallRecoveryDirectory, assertNativeUninstallSupport } from './internal/inventory.js';
export { writeUninstallTombstone, readUninstallTombstone, completedUninstallPreview, resumeUninstallFinalTail, uninstallRestoreRelease } from './internal/tombstone.js';
export { prepareUninstallBackup } from './internal/backup.js';
export { observeUninstallInventory } from './internal/observed-inventory.js';
export { observeUninstallWork, installationScopes } from './internal/quiescence.js';
export { projectTracking } from './internal/vcs.js';
export { createUninstallArchive, restoreUninstallArchive, hasUninstallArchive, uninstallArchiveRoots } from './internal/archive.js';
