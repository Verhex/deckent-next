import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ModelInvocationStoreError, type ModelInvocationStore } from '#engine/index.js';
import { MODEL_INVOCATION_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';
import { loadInvocationRecord } from './read.js';

const optionsSchema = z.object({ busyTimeoutMs: z.number().int().nonnegative().max(2_147_483_647) }).strict();
export type ModelInvocationReader = Pick<ModelInvocationStore, 'loadInvocation' | 'close'>;
class SqliteModelInvocationReader implements ModelInvocationReader {
  constructor(private readonly db: DatabaseSync) {}
  async loadInvocation(scopeId: string, invocationId: string) { return loadInvocationRecord(this.db, scopeId, invocationId); }
  close() { this.db.close(); }
}
export function openSqliteModelInvocationReader(path: string, options: { readonly busyTimeoutMs: number }): ModelInvocationReader {
  const parsed = optionsSchema.safeParse(options);
  if (typeof path !== 'string' || !path || !parsed.success) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new NativeDatabase(path, { readOnly: true, timeout: parsed.data.busyTimeoutMs });
    requireLedgerVersion(db, MODEL_INVOCATION_LEDGER_VERSION);
    return new SqliteModelInvocationReader(db);
  } catch (error) {
    try { db?.close(); } catch { /* No read-only outcome can have committed. */ }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ATTEMPT_STORE_VERSION') throw error;
    throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  }
}
