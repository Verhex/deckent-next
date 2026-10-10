import type { DatabaseSync } from 'node:sqlite';
import { openSqliteLedger, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { recoverProviderSpendHold, providerSpendReservationDigest, ProviderSpendError, providerSpendHasZeroTariff,
  type ProviderSpendRecoveryStore, type ProviderSpendRecoveryResult } from '#engine/index.js';
import { readSpendCheckpoint, writeSpendCheckpoint, decodeSpendReservation } from './spend-checkpoint.js';
import { loadInvocationRecord } from './read.js';
class SqliteProviderSpendRecoveryStore implements ProviderSpendRecoveryStore {
  constructor(private readonly db: DatabaseSync) {}
  async recoverCertifiedHolds(recordedAtMs: number): Promise<ProviderSpendRecoveryResult> {
    let scopeCursor = '', invocationCursor = '', released = 0, zeroTariff = 0;
    const inconsistent: { scopeId: string; invocationId: string }[] = [];
    for (;;) {
      const rows = this.db.prepare(`SELECT scope_id,invocation_id FROM model_invocation_spend_reservations
        WHERE json_extract(record,'$.disposition.state')='held' AND json_extract(record,'$.reconciliation') IS NULL AND (scope_id COLLATE BINARY>? OR (scope_id=? AND invocation_id COLLATE BINARY>?))
        ORDER BY scope_id COLLATE BINARY,invocation_id COLLATE BINARY LIMIT 100`).all(scopeCursor, scopeCursor, invocationCursor);
      if (!rows.length) break;
      for (const key of rows) {
        const scopeId = String(key.scope_id), invocationId = String(key.invocation_id);
        scopeCursor = scopeId; invocationCursor = invocationId;
        try {
          this.db.exec('BEGIN IMMEDIATE');
          const row = this.db.prepare('SELECT record,digest FROM model_invocation_spend_reservations WHERE scope_id=? AND invocation_id=?').get(scopeId, invocationId);
          const checkpoint = readSpendCheckpoint(this.db, scopeId), record = loadInvocationRecord(this.db, scopeId, invocationId);
          if (!row || !checkpoint || !record) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
          const reservation = decodeSpendReservation(row, record.receipt, checkpoint, this.db);
          // A complete summary without retained, verified body bytes cannot certify a historical HTTP release.
          const retained = record.receipt.outcome?.state === 'rejected' && (record.receipt.outcome.evidence.reason === 'not-sent'
            || record.content?.kind === 'response-body');
          const result = retained || providerSpendHasZeroTariff(reservation.descriptor.quote) ? recoverProviderSpendHold(checkpoint.account, reservation, record.receipt, recordedAtMs) : null;
          if (result) {
            const updated = this.db.prepare('UPDATE model_invocation_spend_reservations SET record=?,digest=? WHERE scope_id=? AND invocation_id=? AND digest=?').run(JSON.stringify(result.reservation), providerSpendReservationDigest(result.reservation), scopeId, invocationId, row.digest!);
            if (updated.changes !== 1) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
            writeSpendCheckpoint(this.db, checkpoint, result.account, false);
          }
          this.db.exec('COMMIT');
          if (result) { released++; if (result.zeroTariff) zeroTariff++; }
        } catch (error) {
          if (this.db.isTransaction) this.db.exec('ROLLBACK');
          if (!(error instanceof ProviderSpendError)) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
          inconsistent.push({ scopeId, invocationId });
        }
      }
    }
    return Object.freeze({ released, zeroTariff, inconsistent: Object.freeze(inconsistent) });
  }
  close() { this.db.close(); }
}
export function openSqliteProviderSpendRecoveryStore(path: string, options: SqliteLedgerOptions): ProviderSpendRecoveryStore {
  return new SqliteProviderSpendRecoveryStore(openSqliteLedger(path, options, 'forbid'));
}
