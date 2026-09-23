import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
export type { SqliteAttemptStore } from './internal/sqlite.js';
/** Load the native driver only when this storage adapter is selected by composition. */
export async function openSqliteAttemptStore(path: string, options: SqliteLedgerOptions, migration: 'allow' | 'forbid' = 'allow', profiles?: import('#engine/index.js').SupervisorProfileValidator) {
  const { SqliteAttemptStore } = await import('./internal/sqlite.js');
  return new SqliteAttemptStore(path, options, migration, profiles);
}
export { InstallationLedgerError } from './internal/installation.js';
export type { InstallationLedgerErrorCode, InstallationLedgerOwnership } from './internal/installation.js';
/** Load the native driver only for the explicit installer operation. */
export async function initializeInstallationLedger(path: string, options: SqliteLedgerOptions, ownership: unknown, pool: unknown) {
  const implementation = await import('./internal/installation.js');
  return implementation.initializeInstallationLedger(path, options, ownership, pool);
}
export async function verifyInstallationLedger(path: string, ownership: unknown, pool: unknown) {
  const implementation = await import('./internal/installation.js');
  return implementation.verifyInstallationLedger(path, ownership, pool);
}
export type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
export type { SqliteInventoryReader, SqliteInventoryOptions } from './internal/inventory-reader.js';
export async function openSqliteInventoryReader(path: string, options: import('./internal/inventory-reader.js').SqliteInventoryOptions) {
  const { SqliteInventoryReader } = await import('./internal/inventory-reader.js');
  return new SqliteInventoryReader(path, options);
}
/** Service-start upgrade of an existing older ledger with a versioned backup; loads the native driver lazily. */
export async function upgradeExistingProductLedger(path: string, options: SqliteLedgerOptions, backupDirectory: string, now: Date,
  profiles?: import('#engine/index.js').SupervisorProfileValidator) {
  const { upgradeExistingLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  return upgradeExistingLedger(path, options, backupDirectory, now, profiles);
}
export type { LedgerUpgrade } from '#adapters/core/sqlite-ledger/index.js';
