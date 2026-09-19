import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ModelReference } from '#domain/index.js';
import { ModelActivationStoreError, type ModelActivationReader } from '#engine/index.js';
import { MODEL_ACTIVATION_LEDGER_VERSION, requireLedgerVersion, sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';
import { activationFailure, loadActivationRecord } from './read.js';

const optionsSchema = z.object({ busyTimeoutMs: z.number().int().nonnegative().max(2_147_483_647) }).strict();
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
    const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new NativeDatabase(path, { readOnly: true, timeout: parsed.data.busyTimeoutMs });
    requireLedgerVersion(db, MODEL_ACTIVATION_LEDGER_VERSION);
    return new SqliteModelActivationReader(db);
  } catch (error) {
    try { db?.close(); } catch { /* Read-only open failed; no outcome can have committed. */ }
    const mapped = sqliteFailure(error);
    if (mapped && typeof mapped === 'object' && 'code' in mapped && mapped.code === 'ATTEMPT_STORE_VERSION') throw mapped;
    return activationFailure(mapped);
  }
}
