import type { DatabaseSync } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { CURRENT_LEDGER_VERSION, openSqliteLedgerReadOnly, sqliteLedgerOptionsSchema, assertSqliteEngineSupported,
  type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { executionPoolSchema, type ExecutionPool, type InstallationPoolStore } from '#engine/index.js';
import { InstallationLedgerError, SqliteExecutionPools } from '#adapters/core/attempt-store/index.js';

type Observation = Awaited<ReturnType<InstallationPoolStore['inspect']>>;
function inspect(db: DatabaseSync, pool: ExecutionPool): Observation {
  const ledgerVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (ledgerVersion !== CURRENT_LEDGER_VERSION) return { status: 'conflict', reason: 'ledger-version', ledgerVersion };
  const row = db.prepare('SELECT policy FROM execution_pools WHERE pool_id=?').get(pool.poolId);
  if (!row) return { status: 'preview' };
  const stored = executionPoolSchema.parse(JSON.parse(String(row.policy)));
  if (stored.poolId !== pool.poolId) return { status: 'unavailable', reason: 'ledger-unavailable' };
  return row.policy === JSON.stringify(pool) ? { status: 'current', stored } : { status: 'conflict', reason: 'pool-policy', stored };
}
/** No migrator, no ledger creation or journal-mode changes. Composition admits existing managed-file custody. */
export function installationPoolStore(path: string, options: SqliteLedgerOptions): InstallationPoolStore {
  const open = async (apply: boolean): Promise<DatabaseSync | null> => {
    try { if (!(await lstat(path)).isFile()) return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!apply) return openSqliteLedgerReadOnly(path, options);
    assertSqliteEngineSupported(process.versions.sqlite);
    const parsed = sqliteLedgerOptionsSchema.parse(options), { DatabaseSync } = await import('node:sqlite');
    // SQLite's mode=rw omits CREATE even if the file disappears after the custody precheck.
    return new DatabaseSync(`${pathToFileURL(path).href}?mode=rw`, { timeout: parsed.busyTimeoutMs, enableForeignKeyConstraints: true });
  };
  return {
    async inspect(pool) {
      let db: DatabaseSync | null = null;
      try { db = await open(false); return db ? inspect(db, pool) : { status: 'unavailable', reason: 'ledger-missing' }; }
      catch { return { status: 'unavailable', reason: 'ledger-unavailable' }; }
      finally { db?.close(); }
    },
    async provision(pool, audit) {
      // Refuse missing/old/new ledgers before opening a writer; repeat the read under the write lock.
      const first = await this.inspect(pool);
      if (first.status !== 'preview') return first;
      let db;
      try { db = await open(true); } catch { return { status: 'unavailable', reason: 'ledger-unavailable' }; }
      if (!db) return { status: 'unavailable', reason: 'ledger-missing' };
      let active = false, commitAttempted = false;
      try {
        const parsed = sqliteLedgerOptionsSchema.parse(options);
        db.exec(parsed.durability === 'extra' ? 'PRAGMA synchronous=EXTRA' : 'PRAGMA synchronous=FULL');
        db.exec('BEGIN IMMEDIATE'); active = true;
        const again = inspect(db, pool);
        if (again.status !== 'preview') { db.exec('ROLLBACK'); active = false; return again; }
        audit(new SqliteAuditStore(db));
        new SqliteExecutionPools(db).create(pool);
        commitAttempted = true; db.exec('COMMIT'); active = false;
        return { status: 'created' };
      } catch (error) {
        if (active) { try { db.exec('ROLLBACK'); } catch { throw new InstallationLedgerError('INSTALLATION_LEDGER_OUTCOME_UNKNOWN'); } }
        if (commitAttempted) throw new InstallationLedgerError('INSTALLATION_LEDGER_OUTCOME_UNKNOWN');
        throw error;
      } finally { db.close(); }
    },
  };
}
