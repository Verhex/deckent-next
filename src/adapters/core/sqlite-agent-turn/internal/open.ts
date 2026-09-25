import { openSqliteLedger, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { SqliteAgentTurnStore } from './store.js';

export function openSqliteAgentTurnStore(path: string, options: SqliteLedgerOptions, migrationMode: 'allow' | 'forbid' = 'allow') {
  return new SqliteAgentTurnStore(openSqliteLedger(path, options, migrationMode));
}
