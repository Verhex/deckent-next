import type { SupervisorProfileValidator } from '#engine/index.js';
import type { ModelInvocationStore } from '#engine/index.js';
import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';

/** Lazy native SQLite boundary; importing adapter aggregates never loads node:sqlite. */
export async function openSqliteModelInvocationStore(path: string, options: SqliteLedgerOptions,
  migrationMode: 'allow' | 'forbid' = 'allow', profiles?: SupervisorProfileValidator): Promise<ModelInvocationStore> {
  const implementation = await import('./internal/open.js');
  return implementation.openSqliteModelInvocationStore(path, options, migrationMode, profiles);
}
export type { ModelInvocationReader } from './internal/reader.js';
export async function openSqliteModelInvocationReader(path: string, options: { readonly busyTimeoutMs: number }) {
  const implementation = await import('./internal/reader.js');
  return implementation.openSqliteModelInvocationReader(path, options);
}
