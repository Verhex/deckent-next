import type { SupervisorProfileValidator } from '#engine/index.js';
import type { ModelAllocationIntegrityReader, ModelInvocationStore, ModelInvocationPurgeStore, ModelInvocationCancellationStore } from '#engine/index.js';
import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';

/** Lazy native SQLite boundary; importing adapter aggregates never loads node:sqlite. */
export async function openSqliteModelInvocationStore(path: string, options: SqliteLedgerOptions,
  migrationMode: 'allow' | 'forbid' = 'allow', profiles?: SupervisorProfileValidator): Promise<ModelInvocationStore & ModelInvocationPurgeStore & ModelInvocationCancellationStore> {
  const implementation = await import('./internal/open.js');
  return implementation.openSqliteModelInvocationStore(path, options, migrationMode, profiles);
}
export type { ModelInvocationReader } from './internal/reader.js';
export async function openSqliteModelInvocationReader(path: string, options: { readonly busyTimeoutMs: number }) {
  const implementation = await import('./internal/reader.js');
  return implementation.openSqliteModelInvocationReader(path, options);
}
export async function openSqliteModelInvocationCancellationInventory(path: string, options: { readonly busyTimeoutMs: number }) {
  const implementation = await import('./internal/cancellation-inventory.js');
  return implementation.openSqliteModelInvocationCancellationInventory(path, options);
}
export async function openSqliteProviderSpendIntegrityReader(path: string, options: { readonly busyTimeoutMs: number }) {
  const implementation = await import('./internal/spend-integrity.js');
  return implementation.openSqliteProviderSpendIntegrityReader(path, options);
}
export async function openSqliteProviderSpendAccountReader(path: string, options: { readonly busyTimeoutMs: number }) {
  const implementation = await import('./internal/spend-account-reader.js');
  return implementation.openSqliteProviderSpendAccountReader(path, options);
}
export async function openSqliteModelAllocationIntegrityReader(path: string,
  options: { readonly busyTimeoutMs: number }): Promise<ModelAllocationIntegrityReader> {
  const implementation = await import('./internal/allocation-integrity.js');
  return implementation.openSqliteModelAllocationIntegrityReader(path, options);
}
