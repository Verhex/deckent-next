import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { parseProviderSpendAccountQuery, type ProviderSpendAccountQuery } from '#domain/index.js';
import { parseProviderSpendAuditReceipt, ProviderSpendError, type ProviderSpendAccountReader } from '#engine/index.js';
import { PROVIDER_SPEND_AUDIT_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';
import { readSpendCheckpoint } from './spend-checkpoint.js';

const optionsSchema = z.object({ busyTimeoutMs: z.number().int().nonnegative().max(2_147_483_647) }).strict();

class SqliteProviderSpendAccountReader implements ProviderSpendAccountReader {
  constructor(private readonly db: DatabaseSync) {}

  async loadSnapshot(input: ProviderSpendAccountQuery) {
    let query: ProviderSpendAccountQuery;
    try { query = parseProviderSpendAccountQuery(input); }
    catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
    this.db.exec('BEGIN');
    try {
      const checkpoint = readSpendCheckpoint(this.db, query.scopeId);
      const row = this.db.prepare(`SELECT scope_id,budget_id,budget_revision,command_id,record,digest
        FROM provider_spend_audits WHERE scope_id=? AND budget_id=? AND budget_revision=?
        ORDER BY sequence DESC LIMIT 1`).get(query.scopeId, query.budgetId, query.budgetRevision);
      let audit = null;
      if (row) {
        if (typeof row.record !== 'string') throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
        try { audit = parseProviderSpendAuditReceipt(JSON.parse(row.record)); }
        catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
        if (audit.digest !== row.digest || audit.command.scopeId !== row.scope_id
          || audit.command.budgetId !== row.budget_id || audit.command.budgetRevision !== row.budget_revision
          || audit.command.commandId !== row.command_id) {
          throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
        }
      }
      this.db.exec('COMMIT');
      return Object.freeze({ checkpoint, audit });
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      if (error instanceof ProviderSpendError) throw error;
      throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    }
  }

  close() { this.db.close(); }
}

export function openSqliteProviderSpendAccountReader(path: string,
  options: { readonly busyTimeoutMs: number }): ProviderSpendAccountReader {
  const parsed = optionsSchema.safeParse(options);
  if (typeof path !== 'string' || !path || !parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new NativeDatabase(path, { readOnly: true, timeout: parsed.data.busyTimeoutMs });
    requireLedgerVersion(db, PROVIDER_SPEND_AUDIT_LEDGER_VERSION);
    return new SqliteProviderSpendAccountReader(db);
  } catch (error) {
    try { db?.close(); } catch { /* The read-only reader never wrote state. */ }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ATTEMPT_STORE_VERSION') throw error;
    throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  }
}
