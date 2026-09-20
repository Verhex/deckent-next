import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ModelInvocationStoreError, type ModelInvocationStore, type ModelInvocationInspectionReader } from '#engine/index.js';
import { MODEL_INVOCATION_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';
import { decodeInvocationRecord, invocationIdentity, invocationRow, loadInvocationRecord } from './read.js';
import { decodeInvocationControl } from './control.js';

const optionsSchema = z.object({ busyTimeoutMs: z.number().int().nonnegative().max(2_147_483_647) }).strict();
export type ModelInvocationReader = Pick<ModelInvocationStore, 'loadInvocation' | 'close'> & ModelInvocationInspectionReader;
class SqliteModelInvocationReader implements ModelInvocationReader {
  constructor(private readonly db: DatabaseSync) {}
  async loadInvocation(scopeId: string, invocationId: string) { return loadInvocationRecord(this.db, scopeId, invocationId); }
  async loadInspection(scopeInput: string, invocationInput: string) {
    const scopeId = invocationIdentity(scopeInput), invocationId = invocationIdentity(invocationInput);
    // One joined SQLite statement binds outcome, retained content, purge and cancellation to the same snapshot.
    const row = invocationRow(this.db, scopeId, invocationId);
    const record = decodeInvocationRecord(row, scopeId, invocationId, 'invocation_id');
    return record ? Object.freeze({ record, control: decodeInvocationControl(row, record) }) : null;
  }
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
