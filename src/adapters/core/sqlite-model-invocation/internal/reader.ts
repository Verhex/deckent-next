import { persistedInteger } from '#domain/index.js';
import { readInvocationPlanUsage } from './plan-usage.js';
import { readSpendCheckpoint, decodeSpendReservation } from './spend-checkpoint.js';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ProviderSpendError, ModelInvocationStoreError, type ModelInvocationStore, type ModelInvocationInspectionReader } from '#engine/index.js';
import { ledgerTransaction, openLedgerDatabase, MODEL_INVOCATION_LEDGER_VERSION, PROVIDER_SPEND_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';
import { decodeInvocationRecord, invocationIdentity, invocationRow, loadInvocationCommandRecord, loadInvocationRecord } from './read.js';
import { decodeInvocationControl } from './control.js';

const optionsSchema = z.strictObject({ busyTimeoutMs: persistedInteger().nonnegative().max(2_147_483_647) });
export type ModelInvocationReader = Pick<ModelInvocationStore, 'loadInvocation' | 'loadReceipt' | 'close'> & ModelInvocationInspectionReader;
class SqliteModelInvocationReader implements ModelInvocationReader {
  constructor(private readonly db: DatabaseSync) {}
  async loadInvocation(scopeId: string, invocationId: string) { return loadInvocationRecord(this.db, scopeId, invocationId); }
  async loadReceipt(scopeInput: string, commandInput: string) {
    return loadInvocationCommandRecord(this.db, scopeInput, commandInput);
  }
  async loadInspection(scopeInput: string, invocationInput: string) {
    const scopeId = invocationIdentity(scopeInput), invocationId = invocationIdentity(invocationInput);
    // A read transaction binds control/outcome and financial rows to one snapshot without a writer lock.
    return ledgerTransaction(this.db, () => {
      const row = invocationRow(this.db, scopeId, invocationId);
      const record = decodeInvocationRecord(row, scopeId, invocationId, 'invocation_id');
      if (!record) { return null; }
      let spending = null;
      const version = requireLedgerVersion(this.db, MODEL_INVOCATION_LEDGER_VERSION);
      if (version === PROVIDER_SPEND_LEDGER_VERSION - 1
        && this.db.prepare(`SELECT 1 FROM model_invocation_spend_reservations
          WHERE scope_id=? AND invocation_id=? LIMIT 1`).get(scopeId, invocationId)) {
        requireLedgerVersion(this.db, PROVIDER_SPEND_LEDGER_VERSION);
      }
      if (version >= PROVIDER_SPEND_LEDGER_VERSION) {
        const reservation = this.db.prepare('SELECT record,digest FROM model_invocation_spend_reservations WHERE scope_id=? AND invocation_id=?')
          .get(scopeId, invocationId);
        if (reservation) {
          const checkpoint = readSpendCheckpoint(this.db, scopeId);
          if (!checkpoint) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
          spending = decodeSpendReservation(reservation, record.receipt, checkpoint, this.db);
        }
      }
      const planUsage = readInvocationPlanUsage(this.db, version, record);
      const result = Object.freeze({ record, control: decodeInvocationControl(row, record), spending,
        ...(record.receipt.profile.schemaVersion !== 1 ? { planUsage } : {}) });
      return result;
    }, { mode: 'read', unknown: () => new ModelInvocationStoreError('MODEL_INVOCATION_OUTCOME_UNKNOWN'), failure: error => error });
  }

  close() { this.db.close(); }
}
export function openSqliteModelInvocationReader(path: string, options: { readonly busyTimeoutMs: number }): ModelInvocationReader {
  const parsed = optionsSchema.safeParse(options);
  if (typeof path !== 'string' || !path || !parsed.success) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  let db: DatabaseSync | undefined;
  try {
    db = openLedgerDatabase(path, { readOnly: true, timeout: parsed.data.busyTimeoutMs });
    requireLedgerVersion(db, MODEL_INVOCATION_LEDGER_VERSION);
    return new SqliteModelInvocationReader(db);
  } catch (error) {
    try { db?.close(); } catch { /* No read-only outcome can have committed. */ }
    if (error && typeof error === 'object' && 'code' in error
      && (error.code === 'ATTEMPT_STORE_VERSION' || error.code === 'ATTEMPT_STORE_SQLITE_UNSUPPORTED')) throw error;
    throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  }
}
