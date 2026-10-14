import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import type { AuditCheckpointStore } from '#engine/index.js';

/** Durable Core audit events on the shared ledger (v41); node:sqlite is loaded only when a store is opened. */
export async function openSqliteAuditStore(path: string, options: SqliteLedgerOptions,
  migrationMode: 'allow' | 'forbid' = 'forbid'): Promise<AuditCheckpointStore & { close(): void }> {
  const implementation = await import('./internal/open.js');
  return implementation.openSqliteAuditStore(path, options, migrationMode);
}
export async function openReadOnlyAuditStore(path: string, options: SqliteLedgerOptions): Promise<AuditCheckpointStore & { close(): void }> {
  return (await import('./internal/read.js')).openReadOnlyAuditStore(path, options);
}
// A store on a caller's open ledger connection, so an audit event commits in the caller's transaction (K5 pool hold); no driver load.
export { SqliteAuditStore } from './internal/store.js';
