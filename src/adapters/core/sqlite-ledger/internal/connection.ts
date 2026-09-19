import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { AttemptStoreError, type SupervisorProfileValidator } from '#engine/index.js';
import { migrateLedger } from './schema.js';
import { sqliteLedgerOptionsSchema, sqliteFailure, type SqliteLedgerOptions } from './options.js';

/** Open the existing product ledger for normal writes. The caller owns close and path custody.
 * Installer and read-only readers retain their distinct precheck/transaction protocols.
 * This module is reached only through a selected adapter's lazy implementation import.
 */
export function openSqliteLedger(path: string, options: SqliteLedgerOptions,
  migration: 'allow' | 'forbid' = 'allow', profiles?: SupervisorProfileValidator): DatabaseSync {
  if (migration !== 'allow' && migration !== 'forbid') throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
  const parsed = sqliteLedgerOptionsSchema.safeParse(options);
  if (!parsed.success) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
  let db: DatabaseSync;
  try {
    const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new NativeDatabase(path, { timeout: parsed.data.busyTimeoutMs });
  }
  catch (error) { throw sqliteFailure(error); }
  try {
    db.exec('BEGIN IMMEDIATE');
    migrateLedger(db, migration, profiles);
    db.exec('COMMIT');
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
