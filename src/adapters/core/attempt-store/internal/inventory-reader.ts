import { SqliteRunJournal } from './runs.js';
import { identitySchema } from '#domain/index.js';
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
    catch (error) { throw readFailure(error); }
    try {
      if (![2, 3, 4].includes(Number(this.db.prepare('PRAGMA user_version').get()?.user_version))) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
    } catch (error) { this.db.close(); throw readFailure(error); }
  }
  async listDispatches(query: DispatchInventoryQuery) {
    try { return await new SqliteDispatchJournal(this.db).listDispatches(query); }
    catch (error) { throw readFailure(error); }
  }
  async loadRunReceipt(scopeId: string, commandId: string) {
    try {
      if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < 3) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
      return await new SqliteRunJournal(this.db).loadRunReceipt(scopeId, commandId);
    } catch (error) { throw readFailure(error); }
  }
  async loadRun(scopeId: string, runId: string) {
    const scope = identitySchema.parse(scopeId); const run = identitySchema.parse(runId);
    try {
      if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < 3) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
      return await new SqliteRunJournal(this.db).loadRun(scope, run);
    } catch (error) { throw readFailure(error); }
  }
  close(): void { this.db.close(); }
}

function readFailure(error: unknown): unknown {
  const mapped = sqliteFailure(error);
  if (mapped !== error || error instanceof AttemptStoreError) return mapped;
  if (error && typeof error === 'object' && 'errcode' in error && typeof error.errcode === 'number') {
    return new AttemptStoreError([11, 26].includes(error.errcode & 255) ? 'ATTEMPT_STORE_CORRUPT' : 'ATTEMPT_STORE_READ_UNAVAILABLE');
  }
  return error;
}
