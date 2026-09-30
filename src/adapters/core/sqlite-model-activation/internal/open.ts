import type { SupervisorProfileValidator } from '#engine/index.js';
import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { MODEL_CATALOG_LEDGER_VERSION, assertSqliteEngineSupported, openSqliteLedger, requireLedgerVersion, sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';
import { SqliteModelActivationStore } from './store.js';
import { SqliteModelCatalogReader, SqliteModelCatalogStore } from './catalog.js';

export function openSqliteModelActivationStore(path: string, options: SqliteLedgerOptions,
  migrationMode: 'allow' | 'forbid' = 'allow', profiles?: SupervisorProfileValidator) {
  return new SqliteModelActivationStore(openSqliteLedger(path, options, migrationMode, profiles));
}
/** Ledger model catalog writer (WORKER-CURRENCY-1). */
export function openSqliteModelCatalogStore(path: string, options: SqliteLedgerOptions, migrationMode: 'allow' | 'forbid' = 'allow') {
  return new SqliteModelCatalogStore(openSqliteLedger(path, options, migrationMode));
}
/** Read-only catalog view for Run admission: never migrates or writes; a ledger older than v43 or newer than this build is refused. */
export function openSqliteModelCatalogReader(path: string, options: { readonly busyTimeoutMs: number }) {
  let db: DatabaseSync | undefined;
  try {
    assertSqliteEngineSupported(process.versions.sqlite);
    const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new NativeDatabase(path, { readOnly: true, timeout: options.busyTimeoutMs });
    requireLedgerVersion(db, MODEL_CATALOG_LEDGER_VERSION);
    return new SqliteModelCatalogReader(db);
  } catch (error) {
    try { db?.close(); } catch { /* Read-only open failed; nothing was written. */ }
    throw sqliteFailure(error);
  }
}
