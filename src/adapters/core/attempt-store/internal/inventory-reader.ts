import { readIntegration } from './integration.js';
import { readRunBoundDispatch, readRunBoundTask } from './run-dispatch-lookup.js';
import { requireLedgerVersion, INTEGRATION_LEDGER_VERSION, DISPATCH_LEDGER_VERSION, RUN_LEDGER_VERSION, WORKER_EVENT_LOG_LEDGER_VERSION, sqliteFailure, sqliteLedgerOptionsSchema,
  assertSqliteEngineSupported, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { SqliteRunJournal } from './runs.js';
import { identitySchema } from '#domain/index.js';
import { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError, type DispatchInventoryQuery, type DispatchInventoryStore } from '#engine/index.js';
import { SqliteDispatchJournal } from './dispatch.js';
import { SqliteWorkerEventLogs } from './worker-events.js';

export type SqliteInventoryOptions = Pick<SqliteLedgerOptions, 'busyTimeoutMs'>;
/** Existing ledger only: no creation, migrations, journal-mode changes or write methods.
 * WAL readers may use SQLite shared-memory bookkeeping. Path custody belongs to composition.
 */
export class SqliteInventoryReader implements DispatchInventoryStore {
  private readonly db: DatabaseSync;
  constructor(path: string, options: SqliteInventoryOptions) {
    const parsed = sqliteLedgerOptionsSchema.unwrap().pick({ busyTimeoutMs: true }).strict().safeParse(options);
    if (!parsed.success) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
    assertSqliteEngineSupported(process.versions.sqlite);
    try { this.db = new DatabaseSync(path, { readOnly: true, timeout: parsed.data.busyTimeoutMs }); }
    catch (error) { throw readFailure(error); }
    try {
      requireLedgerVersion(this.db, DISPATCH_LEDGER_VERSION);
    } catch (error) { this.db.close(); throw readFailure(error); }
  }
  async loadIntegration(query: import('#engine/index.js').IntegrationQuery) {
    requireLedgerVersion(this.db, INTEGRATION_LEDGER_VERSION);
    try { return readIntegration(this.db, query); } catch (error) { throw readFailure(error); }
  }
  async loadBoundDispatch(identity: import('#domain/index.js').AttemptIdentity) {
    requireLedgerVersion(this.db, RUN_LEDGER_VERSION);
    return readRunBoundDispatch(this.db, identity).dispatch;
  }
  async loadBoundTask(identity: import('#domain/index.js').AttemptIdentity) {
    requireLedgerVersion(this.db, RUN_LEDGER_VERSION);
    return readRunBoundTask(this.db, identity);
  }
  async listDispatches(query: DispatchInventoryQuery) {
    try { return await new SqliteDispatchJournal(this.db).listDispatches(query); }
    catch (error) { throw readFailure(error); }
  }
  async loadRunReceipt(scopeId: string, commandId: string) {
    try {
      requireLedgerVersion(this.db, RUN_LEDGER_VERSION);
      return await new SqliteRunJournal(this.db).loadRunReceipt(scopeId, commandId);
    } catch (error) { throw readFailure(error); }
  }
  async loadRun(scopeId: string, runId: string) {
    const scope = identitySchema.parse(scopeId); const run = identitySchema.parse(runId);
    try {
      requireLedgerVersion(this.db, RUN_LEDGER_VERSION);
      return await new SqliteRunJournal(this.db).loadRun(scope, run);
    } catch (error) { throw readFailure(error); }
  }
  /** Sealed worker event log record of one attempt (read-only; WORKER-CURRENCY-2 model rows on workers and run inspect). */
  async loadWorkerEventLog(scopeId: string, attemptId: string) {
    try {
      requireLedgerVersion(this.db, WORKER_EVENT_LOG_LEDGER_VERSION);
      return await new SqliteWorkerEventLogs(this.db).loadWorkerEventLog(scopeId, attemptId);
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
