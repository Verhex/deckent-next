import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import type { AuditStore } from '#engine/index.js';

/** Durable Core audit events on the shared ledger (v41); node:sqlite is loaded only when a store is opened. */
export async function openSqliteAuditStore(path: string, options: SqliteLedgerOptions,
  migrationMode: 'allow' | 'forbid' = 'forbid'): Promise<AuditStore & { close(): void }> {
  const implementation = await import('./internal/open.js');
  return implementation.openSqliteAuditStore(path, options, migrationMode);
}
export type { SqliteAuditStore } from './internal/store.js';
