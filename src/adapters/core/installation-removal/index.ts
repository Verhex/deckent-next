export { InstallationServiceRemovalTarget } from './internal/service.js';
export type { RemovalService, ServiceObservation, ServiceRemovalDriver } from './internal/service.js';
export { InstallationCacheRemovalTarget } from './internal/cache.js';
export type { CacheRemovalResource, CacheRemovalBounds } from './internal/cache.js';

export { UninstallRecovery } from './internal/recovery.js';
export { NativeServiceRemovalDriver, nativeServiceExec, readNativeServiceRecord } from './internal/native-service.js';
export type { NativeServiceRecord, NativeServiceExec } from './internal/native-service.js';
export { InstallationDataRemovalTarget } from './internal/data.js';
export { extendUninstallInventory, uninstallRecoveryDirectory, assertNativeUninstallSupport } from './internal/inventory.js';
export { writeUninstallTombstone, readUninstallTombstone, completedUninstallPreview } from './internal/tombstone.js';
export { prepareUninstallBackup } from './internal/backup.js';
export { observeUninstallInventory } from './internal/observed-inventory.js';
export { hasUnsettledInstallationWork } from './internal/quiescence.js';
