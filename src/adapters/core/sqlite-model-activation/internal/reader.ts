import { persistedInteger } from '#domain/index.js';
import { openReadOnlySqlite } from '#adapters/core/sqlite-read-view/index.js';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ModelReference } from '#domain/index.js';
import { ModelActivationStoreError, type ModelActivationReader } from '#engine/index.js';
import { MODEL_ACTIVATION_LEDGER_VERSION, requireLedgerVersion, sqliteFailure, assertSqliteEngineSupported } from '#adapters/core/sqlite-ledger/index.js';
import { activationFailure, loadActivationRecord } from './read.js';

const optionsSchema = z.strictObject({ busyTimeoutMs: persistedInteger().nonnegative().max(2_147_483_647) });
class SqliteModelActivationReader implements ModelActivationReader {
  constructor(private readonly db: DatabaseSync) {}
  async loadRecord(scopeId: string, reference: ModelReference) { return loadActivationRecord(this.db, scopeId, reference); }
  close() { this.db.close(); }
}
export function openSqliteModelActivationReader(path: string, options: { readonly busyTimeoutMs: number }): ModelActivationReader {
  const parsed = optionsSchema.safeParse(options);
  if (typeof path !== 'string' || !path || !parsed.success) throw new ModelActivationStoreError('MODEL_ACTIVATION_UNAVAILABLE');
  let db: DatabaseSync | undefined;
  try {
    assertSqliteEngineSupported(process.versions.sqlite);
      db = openReadOnlySqlite(path, parsed.data.busyTimeoutMs);
    requireLedgerVersion(db, MODEL_ACTIVATION_LEDGER_VERSION);
    return new SqliteModelActivationReader(db);
  } catch (error) {
    try { db?.close(); } catch { /* Read-only open failed; no outcome can have committed. */ }
    const mapped = sqliteFailure(error);
    if (mapped && typeof mapped === 'object' && 'code' in mapped
      && (mapped.code === 'ATTEMPT_STORE_VERSION' || mapped.code === 'ATTEMPT_STORE_SQLITE_UNSUPPORTED')) throw mapped;
    return activationFailure(mapped);
  }
}
