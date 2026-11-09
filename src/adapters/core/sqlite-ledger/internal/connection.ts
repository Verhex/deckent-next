import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite';
import { createRequire } from 'node:module';
import { AttemptStoreError, type SupervisorProfileValidator } from '#engine/index.js';
import { CURRENT_LEDGER_VERSION, migrateLedger } from './schema.js';
import { sqliteLedgerOptionsSchema, sqliteFailure, assertSqliteEngineSupported, type SqliteLedgerOptions } from './options.js';

/** The ledger open every store unit moves to under SQL-M (contract: `new DatabaseSync(` only here): the DEPS-P0 floor check before any native
 * touch, the lazy `node:sqlite` load (reached only through a selected adapter's lazy import) and validated options. The caller owns close and path custody.
 * `write`: the existing product ledger for normal writes. `read`: never migrates or takes the write lock; the runtime service remains the writer.
 * `anchor` (R6): the runtime service's lifetime connection. While any connection is open no client's close is SQLite's last one, so concurrent
 * client opens never meet -wal/-shm being checkpointed, unlinked and recreated. Read-only; one read maps the WAL index; no transaction is
 * ever held, so it blocks no writer and no checkpoint. Installer and inventory readers retain their distinct precheck/transaction protocols. */
export function openLedgerStore(path: string, options: SqliteLedgerOptions, mode: 'write' | 'read' | 'anchor',
  migration: 'allow' | 'forbid' = 'allow', profiles?: SupervisorProfileValidator, companyId?: string): DatabaseSync {
  const parsed = sqliteLedgerOptionsSchema.safeParse(options);
  if ((migration !== 'allow' && migration !== 'forbid') || !parsed.success) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
  const timeout = parsed.data.busyTimeoutMs;
  let db: DatabaseSync;
  try { db = openLedgerDatabase(path, mode === 'write' ? { timeout, enableForeignKeyConstraints: true } : { readOnly: true, timeout }); }
  catch (error) { throw sqliteFailure(error); }
  if (mode === 'read') return db;
  try {
    if (mode === 'anchor') { db.prepare('PRAGMA user_version').get(); return db; }
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
    if (mode === 'write') try { db.exec('ROLLBACK'); } catch { /* Transaction may not have started. */ }
    db.close(); throw sqliteFailure(error);
  }
}
/** The one raw `node:sqlite` construction: the DEPS-P0 floor check, then the lazy load. Opens that keep their own protocol (installer, inventory,
 * backup copies and checkpoints, member checks) use it directly; it maps no error and the caller owns close. */
export function openLedgerDatabase(path: string, options: DatabaseSyncOptions = {}): DatabaseSync {
  assertSqliteEngineSupported(process.versions.sqlite);
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return new NativeDatabase(path, options);
}
/** Kept for the store units that SQL-M has not yet moved to `openLedgerStore`. */
export const openSqliteLedger = (path: string, options: SqliteLedgerOptions, migration: 'allow' | 'forbid' = 'allow', profiles?: SupervisorProfileValidator,
  companyId?: string) => openLedgerStore(path, options, 'write', migration, profiles, companyId);
export const openSqliteLedgerReadOnly = (path: string, options: SqliteLedgerOptions) => openLedgerStore(path, options, 'read');
export const openSqliteLedgerAnchor = (path: string, options: SqliteLedgerOptions) => openLedgerStore(path, options, 'anchor');
