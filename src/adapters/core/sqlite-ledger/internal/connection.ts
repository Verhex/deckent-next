import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { AttemptStoreError, type SupervisorProfileValidator } from '#engine/index.js';
import { CURRENT_LEDGER_VERSION, migrateLedger } from './schema.js';
import { sqliteLedgerOptionsSchema, sqliteFailure, assertSqliteEngineSupported, type SqliteLedgerOptions } from './options.js';

/** Open the existing product ledger for normal writes. The caller owns close and path custody.
 * Installer and read-only readers retain their distinct precheck/transaction protocols.
 * This module is reached only through a selected adapter's lazy implementation import.
 */
export function openSqliteLedger(path: string, options: SqliteLedgerOptions,
  migration: 'allow' | 'forbid' = 'allow', profiles?: SupervisorProfileValidator, companyId?: string): DatabaseSync {
  assertSqliteEngineSupported(process.versions.sqlite);
  if (migration !== 'allow' && migration !== 'forbid') throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
  const parsed = sqliteLedgerOptionsSchema.safeParse(options);
  if (!parsed.success) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
  let db: DatabaseSync;
  try {
    const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new NativeDatabase(path, { timeout: parsed.data.busyTimeoutMs, enableForeignKeyConstraints: true });
  }
  catch (error) { throw sqliteFailure(error); }
  try {
    /* R6: a current ledger needs no migration, so its open takes no write lock (under load 99% of ATTEMPT_STORE_BUSY was this check).
     * Any other version (older, newer, unreadable) takes the lock and `migrateLedger` re-reads and judges it there, as before. */
    if (db.prepare('PRAGMA user_version').get()?.user_version !== CURRENT_LEDGER_VERSION) {
      db.exec('BEGIN IMMEDIATE'); migrateLedger(db, migration, profiles, companyId); db.exec('COMMIT');
    }
    const journal = { wal: 'PRAGMA journal_mode=WAL', delete: 'PRAGMA journal_mode=DELETE' };
    const durability = { full: 'PRAGMA synchronous=FULL', extra: 'PRAGMA synchronous=EXTRA' };
    const selected = db.prepare(journal[parsed.data.journalMode]).get()?.journal_mode;
    if (selected !== parsed.data.journalMode) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
    db.exec(durability[parsed.data.durability]);
    return db;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Transaction may not have started. */ }
    db.close(); throw sqliteFailure(error);
  }
}

/** Read an existing ledger without migrating or taking the write lock. The runtime service remains the writer. */
export function openSqliteLedgerReadOnly(path: string, options: SqliteLedgerOptions): DatabaseSync {
  assertSqliteEngineSupported(process.versions.sqlite);
  const parsed = sqliteLedgerOptionsSchema.safeParse(options);
  if (!parsed.success) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
  try {
    const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    return new NativeDatabase(path, { readOnly: true, timeout: parsed.data.busyTimeoutMs });
  } catch (error) { throw sqliteFailure(error); }
}

/** R6: the runtime service's lifetime connection. While any connection is open no client's close is SQLite's last one, so concurrent
 * client opens never meet -wal/-shm being checkpointed, unlinked and recreated. Read-only; one read maps the WAL index; no transaction is
 * ever held, so it blocks no writer and no checkpoint. The caller closes it when its custody ends. */
export function openSqliteLedgerAnchor(path: string, options: SqliteLedgerOptions): DatabaseSync {
  const db = openSqliteLedgerReadOnly(path, options);
  try { db.prepare('PRAGMA user_version').get(); return db; } catch (error) { db.close(); throw sqliteFailure(error); }
}
