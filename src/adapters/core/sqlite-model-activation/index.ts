import type { SupervisorProfileValidator } from '#engine/index.js';
import type { ModelActivationStore } from '#engine/index.js';
import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';

/** Lazy native SQLite boundary; importing adapter aggregates never loads node:sqlite. */
export async function openSqliteModelActivationStore(path: string, options: SqliteLedgerOptions,
  migrationMode: 'allow' | 'forbid' = 'allow', profiles?: SupervisorProfileValidator): Promise<ModelActivationStore> {
  const implementation = await import('./internal/open.js');
  return implementation.openSqliteModelActivationStore(path, options, migrationMode, profiles);
}
export type { ModelActivationReader } from '#engine/index.js';
export async function openSqliteModelActivationReader(path: string, options: { readonly busyTimeoutMs: number }) {
  const implementation = await import('./internal/reader.js');
  return implementation.openSqliteModelActivationReader(path, options);
}
