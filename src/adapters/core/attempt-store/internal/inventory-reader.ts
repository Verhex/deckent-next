import { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError, type DispatchInventoryQuery, type DispatchInventoryStore } from '#engine/index.js';
import { sqliteAttemptOptionsSchema, sqliteFailure, type SqliteAttemptOptions } from './options.js';
import { SqliteDispatchJournal } from './dispatch.js';

export type SqliteInventoryOptions = Pick<SqliteAttemptOptions, 'busyTimeoutMs'>;
/** Existing ledger only: no creation, migrations, journal-mode changes or write methods.
 * WAL readers may use SQLite shared-memory bookkeeping. Path custody belongs to composition.
 */
export class SqliteInventoryReader implements DispatchInventoryStore {
  private readonly db: DatabaseSync;
  constructor(path: string, options: SqliteInventoryOptions) {
    const parsed = sqliteAttemptOptionsSchema.unwrap().pick({ busyTimeoutMs: true }).strict().safeParse(options);
    if (!parsed.success) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
    try { this.db = new DatabaseSync(path, { readOnly: true, timeout: parsed.data.busyTimeoutMs }); }
    catch (error) { throw sqliteFailure(error); }
    try {
      if (this.db.prepare('PRAGMA user_version').get()?.user_version !== 2) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
    } catch (error) { this.db.close(); throw sqliteFailure(error); }
  }
  async listDispatches(query: DispatchInventoryQuery) {
    return new SqliteDispatchJournal(this.db).listDispatches(query);
  }
  close(): void { this.db.close(); }
}
