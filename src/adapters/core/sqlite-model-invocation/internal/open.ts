import type { SupervisorProfileValidator } from '#engine/index.js';
import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { SqliteModelInvocationStore } from './store.js';

export function openSqliteModelInvocationStore(path: string, options: SqliteLedgerOptions,
  migrationMode: 'allow' | 'forbid' = 'allow', profiles?: SupervisorProfileValidator) {
  return new SqliteModelInvocationStore(openSqliteLedger(path, options, migrationMode, profiles));
}
