import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { identitySchema } from '#domain/index.js';
import { parseProviderSpendCheckpoint, validateProviderSpendIntegrityPageSize, verifyModelInvocationReceipt, ProviderSpendError,
  type ProviderSpendIntegrityReader, type ProviderSpendIntegrityPageQuery } from '#engine/index.js';
import { PROVIDER_SPEND_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';
import { readSpendCheckpoint, decodeSpendReservation } from './spend-checkpoint.js';

class SqliteProviderSpendIntegrityReader implements ProviderSpendIntegrityReader {
  constructor(private readonly db: DatabaseSync) {}
  async readPage(query: ProviderSpendIntegrityPageQuery) {
    if (!identitySchema.safeParse(query.scopeId).success || (query.afterInvocationId !== null
      && !identitySchema.safeParse(query.afterInvocationId).success)) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    validateProviderSpendIntegrityPageSize(query.limit);
    const expected = query.checkpoint === null ? null : parseProviderSpendCheckpoint(query.checkpoint);
    if ((expected === null) !== (query.afterInvocationId === null)
      || (expected && expected.account.budget.scopeId !== query.scopeId)) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    this.db.exec('BEGIN');
    try {
      const checkpoint = readSpendCheckpoint(this.db, query.scopeId);
      if (expected && checkpoint?.digest !== expected.digest) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
      if (!checkpoint) { this.db.exec('COMMIT'); return null; }
      const select = `SELECT s.invocation_id,s.record,s.digest,i.record AS invocation_record FROM model_invocation_spend_reservations s
        LEFT JOIN model_invocations i ON i.scope_id=s.scope_id AND i.invocation_id=s.invocation_id WHERE s.scope_id=?`;
      const rows = query.afterInvocationId === null
        ? this.db.prepare(`${select} ORDER BY s.invocation_id COLLATE BINARY LIMIT ?`).iterate(query.scopeId, query.limit + 1)
        : this.db.prepare(`${select} AND s.invocation_id COLLATE BINARY>? ORDER BY s.invocation_id COLLATE BINARY LIMIT ?`)
          .iterate(query.scopeId, query.afterInvocationId, query.limit + 1);
      // Retain only the compact reservations; large invocation/profile records are validated one at a time.
      const decoded: ReturnType<typeof decodeSpendReservation>[] = [];
      for (const row of rows) {
        if (typeof row.invocation_record !== 'string') throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
        const receipt = verifyModelInvocationReceipt(JSON.parse(row.invocation_record));
        if (receipt.claim.invocationId !== row.invocation_id) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
        decoded.push(decodeSpendReservation(row, receipt, checkpoint));
      }
      const reservations = Object.freeze(decoded.slice(0, query.limit));
      this.db.exec('COMMIT');
      return Object.freeze({ checkpoint, reservations,
        nextInvocationId: decoded.length > query.limit ? reservations.at(-1)!.descriptor.invocationId : null });
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      if (error instanceof ProviderSpendError) throw error;
      throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    }
  }
  close() { this.db.close(); }
}
export function openSqliteProviderSpendIntegrityReader(path: string, options: { readonly busyTimeoutMs: number }): ProviderSpendIntegrityReader {
  if (typeof path !== 'string' || !path || !Number.isSafeInteger(options.busyTimeoutMs)
    || options.busyTimeoutMs < 0 || options.busyTimeoutMs > 2_147_483_647) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new NativeDatabase(path, { readOnly: true, timeout: options.busyTimeoutMs });
    requireLedgerVersion(db, PROVIDER_SPEND_LEDGER_VERSION);
    return new SqliteProviderSpendIntegrityReader(db);
  } catch (error) {
    try { db?.close(); } catch { /* The reader never wrote state. */ }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ATTEMPT_STORE_VERSION') throw error;
    throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  }
}
