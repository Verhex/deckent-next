import type { SupervisorProfileValidator } from '#engine/index.js';
import type { ModelActivationStore } from '#engine/index.js';
import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';

/** Lazy native SQLite boundary; importing adapter aggregates never loads node:sqlite. */
export async function openSqliteModelActivationStore(path: string, options: SqliteLedgerOptions,
  migrationMode: 'allow' | 'forbid' = 'allow', profiles?: SupervisorProfileValidator): Promise<ModelActivationStore> {
  const implementation = await import('./internal/open.js');
  return implementation.openSqliteModelActivationStore(path, options, migrationMode, profiles);
}
