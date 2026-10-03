import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
export type { SqliteAttemptStore } from './internal/sqlite.js';
/** Load the native driver only when this storage adapter is selected by composition. */
export async function openSqliteAttemptStore(path: string, options: SqliteLedgerOptions, timing: { now: () => number; timeoutMs: number }, migration: 'allow' | 'forbid' = 'allow', profiles?: import('#engine/index.js').SupervisorProfileValidator) {
  const { SqliteAttemptStore } = await import('./internal/sqlite.js');
  return new SqliteAttemptStore(path, options, timing, migration, profiles);
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
/** Read-only Run and sealed worker log reads that each open and close their own connection (observation paths, WORKER-CURRENCY-2). */
export function inventoryReadsPerCall(path: () => Promise<string>, options: import('./internal/inventory-reader.js').SqliteInventoryOptions) {
  const read = async <T>(use: (reader: import('./internal/inventory-reader.js').SqliteInventoryReader) => Promise<T>) => {
    const reader = await openSqliteInventoryReader(await path(), options);
    try { return await use(reader); } finally { reader.close(); }
  };
  return Object.freeze({ receipt: (scopeId: string, commandId: string) => read(reader => reader.receipt(scopeId, commandId)), loadRunPoolEvidence: (scopeId: string, runId: string) => read(reader => reader.loadRunPoolEvidence(scopeId, runId)), loadRun: (scopeId: string, runId: string) => read(reader => reader.loadRun(scopeId, runId)),
    loadWorkerEventLog: (scopeId: string, attemptId: string) => read(reader => reader.loadWorkerEventLog(scopeId, attemptId)) });
}
/** Service-start upgrade of an existing older ledger with a versioned backup; loads the native driver lazily. */
export async function upgradeExistingProductLedger(path: string, options: SqliteLedgerOptions, backupDirectory: string, now: Date,
  profiles?: import('#engine/index.js').SupervisorProfileValidator, companyId?: string) {
  const { upgradeExistingLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  return upgradeExistingLedger(path, options, backupDirectory, now, profiles, companyId);
}
export type { LedgerUpgrade } from '#adapters/core/sqlite-ledger/index.js';
