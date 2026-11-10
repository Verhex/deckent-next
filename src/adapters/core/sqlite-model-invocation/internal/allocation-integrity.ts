import type { DatabaseSync } from 'node:sqlite';
import { identitySchema, type ModelInvocationReceipt } from '#domain/index.js';
import { ModelInvocationStoreError, parseModelAllocationCheckpoint, validateModelAllocationPageSize, verifyModelInvocationReceipt,
  type ModelAllocationIntegrityReader, type ModelAllocationIntegrityQuery } from '#engine/index.js';
import { ledgerTransaction, openLedgerDatabase, MODEL_ALLOCATION_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';
import { readModelAllocationCheckpoint } from './allocation.js';

function invalid(): never { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
class SqliteModelAllocationIntegrityReader implements ModelAllocationIntegrityReader {
  constructor(private readonly db: DatabaseSync) {}
  async readPage(query: ModelAllocationIntegrityQuery) {
    if (!identitySchema.safeParse(query.scopeId).success || !identitySchema.safeParse(query.allocationId).success
      || (query.afterInvocationId !== null && !identitySchema.safeParse(query.afterInvocationId).success)) invalid();
    validateModelAllocationPageSize(query.limit);
    const expected = query.checkpoint === null ? null : parseModelAllocationCheckpoint(query.checkpoint);
    if ((expected === null) !== (query.afterInvocationId === null) || (expected &&
      (expected.allocation.scopeId !== query.scopeId || expected.allocation.allocationId !== query.allocationId))) invalid();
    return ledgerTransaction(this.db, () => {
      try {
        const checkpoint = readModelAllocationCheckpoint(this.db, query.scopeId, query.allocationId);
        if (expected && checkpoint?.digest !== expected.digest) throw new ModelInvocationStoreError('MODEL_INVOCATION_ALLOCATION_CONFLICT');
        if (!checkpoint) { return null; }
        const select = 'SELECT command_id,invocation_id,state,record FROM model_invocations WHERE scope_id=? AND allocation_id=?';
        const rows = query.afterInvocationId === null
          ? this.db.prepare(`${select} ORDER BY invocation_id COLLATE BINARY LIMIT ?`).iterate(query.scopeId, query.allocationId, query.limit + 1)
          : this.db.prepare(`${select} AND invocation_id COLLATE BINARY>? ORDER BY invocation_id COLLATE BINARY LIMIT ?`)
            .iterate(query.scopeId, query.allocationId, query.afterInvocationId, query.limit + 1);
        const receipts: ModelInvocationReceipt[] = [];
        let hasMore = false;
        for (const row of rows) {
          if (typeof row.record !== 'string') invalid();
          const receipt = verifyModelInvocationReceipt(JSON.parse(row.record as string)), allocation = receipt.profile.allocation;
          if (receipt.claim.scopeId !== query.scopeId || receipt.request.scopeId !== query.scopeId
            || receipt.claim.invocationId !== row.invocation_id || receipt.request.commandId !== row.command_id
            || allocation.id !== query.allocationId || allocation.maxCalls !== checkpoint.allocation.maxCalls
            || allocation.maxInFlight !== checkpoint.allocation.maxInFlight || row.state !== (receipt.outcome?.state ?? 'claimed')) invalid();
          if (receipts.length < query.limit) receipts.push(receipt); else hasMore = true;
        }
        return Object.freeze({ checkpoint, receipts: Object.freeze(receipts),
          nextInvocationId: hasMore ? receipts.at(-1)!.claim.invocationId : null });
      } catch (error) {
        if (error instanceof ModelInvocationStoreError) throw error;
        return invalid();
      }
    }, { mode: 'read', unknown: () => new ModelInvocationStoreError('MODEL_INVOCATION_OUTCOME_UNKNOWN'), failure: error => error });
  }
  close() { this.db.close(); }
}
export function openSqliteModelAllocationIntegrityReader(path: string, options: { readonly busyTimeoutMs: number }): ModelAllocationIntegrityReader {
  if (typeof path !== 'string' || !path || !Number.isSafeInteger(options.busyTimeoutMs)
    || options.busyTimeoutMs < 0 || options.busyTimeoutMs > 2_147_483_647) invalid();
  let db: DatabaseSync | undefined;
  try {
    db = openLedgerDatabase(path, { readOnly: true, timeout: options.busyTimeoutMs });
    requireLedgerVersion(db, MODEL_ALLOCATION_LEDGER_VERSION);
    return new SqliteModelAllocationIntegrityReader(db);
  } catch (error) {
    try { db?.close(); } catch { /* Read-only connection owns no persistent effects. */ }
    if (error && typeof error === 'object' && 'code' in error
      && (error.code === 'ATTEMPT_STORE_VERSION' || error.code === 'ATTEMPT_STORE_SQLITE_UNSUPPORTED')) throw error;
    throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  }
}
