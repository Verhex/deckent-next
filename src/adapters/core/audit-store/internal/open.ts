import { AuditError } from '#domain/index.js';
import { openSqliteLedger, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { SqliteAuditStore } from './store.js';

/** A ledger that cannot be opened at this build's version (older, newer or unreadable) is an unavailable audit store, never a silent one. */
export function openSqliteAuditStore(path: string, options: SqliteLedgerOptions, migrationMode: 'allow' | 'forbid' = 'forbid') {
  try { return new SqliteAuditStore(openSqliteLedger(path, options, migrationMode)); }
  catch { throw new AuditError('AUDIT_UNAVAILABLE'); }
}
