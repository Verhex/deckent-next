import { readSpendCheckpoint, decodeSpendReservation } from './spend-checkpoint.js';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ProviderSpendError, ModelInvocationStoreError, type ModelInvocationStore, type ModelInvocationInspectionReader } from '#engine/index.js';
import { MODEL_INVOCATION_LEDGER_VERSION, PROVIDER_SPEND_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';
import { decodeInvocationRecord, invocationIdentity, invocationRow, loadInvocationRecord } from './read.js';
import { decodeInvocationControl } from './control.js';

const optionsSchema = z.object({ busyTimeoutMs: z.number().int().nonnegative().max(2_147_483_647) }).strict();
export type ModelInvocationReader = Pick<ModelInvocationStore, 'loadInvocation' | 'close'> & ModelInvocationInspectionReader;
class SqliteModelInvocationReader implements ModelInvocationReader {
  constructor(private readonly db: DatabaseSync) {}
  async loadInvocation(scopeId: string, invocationId: string) { return loadInvocationRecord(this.db, scopeId, invocationId); }
  async loadInspection(scopeInput: string, invocationInput: string) {
    const scopeId = invocationIdentity(scopeInput), invocationId = invocationIdentity(invocationInput);
    // A read transaction binds control/outcome and financial rows to one snapshot without a writer lock.
    this.db.exec('BEGIN');
    try {
      const row = invocationRow(this.db, scopeId, invocationId);
      const record = decodeInvocationRecord(row, scopeId, invocationId, 'invocation_id');
      if (!record) { this.db.exec('COMMIT'); return null; }
      let spending = null;
      const version = requireLedgerVersion(this.db, MODEL_INVOCATION_LEDGER_VERSION);
      if (version >= PROVIDER_SPEND_LEDGER_VERSION) {
        const reservation = this.db.prepare('SELECT record,digest FROM model_invocation_spend_reservations WHERE scope_id=? AND invocation_id=?')
          .get(scopeId, invocationId);
        if (reservation) {
          const checkpoint = readSpendCheckpoint(this.db, scopeId);
          if (!checkpoint) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
          spending = decodeSpendReservation(reservation, record.receipt, checkpoint);
        }
      }
      const result = Object.freeze({ record, control: decodeInvocationControl(row, record), spending });
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
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
