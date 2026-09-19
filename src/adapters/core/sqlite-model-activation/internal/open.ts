import type { SupervisorProfileValidator } from '#engine/index.js';
import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { SqliteModelActivationStore } from './store.js';

export function openSqliteModelActivationStore(path: string, options: SqliteLedgerOptions,
  migrationMode: 'allow' | 'forbid' = 'allow', profiles?: SupervisorProfileValidator) {
  return new SqliteModelActivationStore(openSqliteLedger(path, options, migrationMode, profiles));
}
