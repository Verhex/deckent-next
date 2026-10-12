import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
export { SqliteRunProposals, readRunProposal } from './internal/store.js';
/** Native loading and ledger selection stay lazy; the caller already authenticated the scope. */
export async function openSqliteRunProposalStore(path: string, options: SqliteLedgerOptions, migration: 'allow' | 'forbid' = 'forbid') {
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const { SqliteRunProposals } = await import('./internal/store.js');
  const db = openSqliteLedger(path, options, migration), store = new SqliteRunProposals(db);
  return Object.assign(store, { close: () => db.close() });
}
/** Observation opens a read-only connection; it cannot migrate or write a proposal. */
export async function openSqliteRunProposalReader(path: string, options: SqliteLedgerOptions) {
  const { openSqliteLedgerReadOnly } = await import('#adapters/core/sqlite-ledger/index.js');
  const { readRunProposal } = await import('./internal/store.js');
  const db = openSqliteLedgerReadOnly(path, options);
  return { loadProposal: async (scopeId: string, commandId: string) => readRunProposal(db, scopeId, commandId), close: () => db.close() };
}
