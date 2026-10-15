import { AuditError } from '#domain/index.js';
import { openSqliteLedgerReadOnly, requireLedgerVersion, AUDIT_EVENT_LEDGER_VERSION, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { SqliteAuditStore } from './store.js';
/** Does not migrate, create keys or change journal settings. Older v41+ ledgers have no checkpoints yet. */
export function openReadOnlyAuditStore(path: string, options: SqliteLedgerOptions) {
  const db = openSqliteLedgerReadOnly(path, options);
  try { requireLedgerVersion(db, AUDIT_EVENT_LEDGER_VERSION); return new SqliteAuditStore(db); }
  catch { db.close(); throw new AuditError('AUDIT_UNAVAILABLE'); }
}
