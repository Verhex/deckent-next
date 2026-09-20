import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { modelInvocationCancellationInventoryQuerySchema, ModelInvocationStoreError, verifyModelInvocationReceipt,
  type ModelInvocationCancellationInventory, type ModelInvocationCancellationInventoryEntry,
  type ModelInvocationCancellationInventoryPage } from '#engine/index.js';
import { MODEL_INVOCATION_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';
import { decodeInvocationControl, invocationControlSelect } from './control.js';

const optionsSchema = z.object({ busyTimeoutMs: z.number().int().nonnegative().max(2_147_483_647) }).strict();
type Row = Readonly<Record<string, unknown>>;
const select = `SELECT i.scope_id,i.command_id,i.invocation_id,i.allocation_id,i.state,i.record,
    ${invocationControlSelect}
  FROM model_invocation_cancellations a
  LEFT JOIN model_invocations i ON i.scope_id=a.scope_id AND i.invocation_id=a.invocation_id
  LEFT JOIN model_invocation_controls k ON k.scope_id=a.scope_id AND k.invocation_id=a.invocation_id
  WHERE a.scope_id=? AND a.invocation_id COLLATE BINARY > ? COLLATE BINARY
    AND (i.state IN ('claimed','unknown') OR i.state IS NULL)
  ORDER BY a.invocation_id COLLATE BINARY LIMIT ?`;

function decode(row: Row, scopeId: string): ModelInvocationCancellationInventoryEntry {
  try {
    if (row['scope_id'] !== scopeId || typeof row['command_id'] !== 'string' || typeof row['invocation_id'] !== 'string'
      || typeof row['allocation_id'] !== 'string' || typeof row['record'] !== 'string') throw new Error();
    const receipt = verifyModelInvocationReceipt(JSON.parse(row['record']));
    const state = receipt.outcome?.state ?? 'claimed';
    if (receipt.request.scopeId !== scopeId || receipt.request.commandId !== row['command_id']
      || receipt.claim.scopeId !== scopeId || receipt.claim.invocationId !== row['invocation_id']
      || receipt.profile.allocation.id !== row['allocation_id'] || state !== row['state']) throw new Error();
    const control = decodeInvocationControl(row, { receipt, content: null, purge: null });
    if (control.cancellation?.disposition !== 'requested'
      || (control.send.state !== 'permitted' && control.send.state !== 'unobserved')) throw new Error();
    return Object.freeze({ receipt, control });
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}

class SqliteModelInvocationCancellationInventory implements ModelInvocationCancellationInventory {
  constructor(private readonly db: DatabaseSync) {}
  async inspectCancellationInventory(input: unknown): Promise<ModelInvocationCancellationInventoryPage> {
    try {
      const query = modelInvocationCancellationInventoryQuerySchema.parse(input);
      const rows = this.db.prepare(select).all(query.scopeId, query.afterInvocationId ?? '', query.limit) as Row[];
      const entries = Object.freeze(rows.map(row => decode(row, query.scopeId)));
      return Object.freeze({ entries,
        nextAfterInvocationId: entries.length === 0 ? null : entries.at(-1)!.receipt.claim.invocationId });
    } catch (error) {
      if (error instanceof ModelInvocationStoreError) throw error;
      throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    }
  }
  close(): void { this.db.close(); }
}

export function openSqliteModelInvocationCancellationInventory(path: string,
  options: { readonly busyTimeoutMs: number }): ModelInvocationCancellationInventory {
  const parsed = optionsSchema.safeParse(options);
  if (typeof path !== 'string' || !path || !parsed.success) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new NativeDatabase(path, { readOnly: true, timeout: parsed.data.busyTimeoutMs });
    requireLedgerVersion(db, MODEL_INVOCATION_LEDGER_VERSION);
    return new SqliteModelInvocationCancellationInventory(db);
  } catch (error) {
    try { db?.close(); } catch { /* Read-only open cannot leave a durable outcome. */ }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ATTEMPT_STORE_VERSION') throw error;
    throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  }
}
