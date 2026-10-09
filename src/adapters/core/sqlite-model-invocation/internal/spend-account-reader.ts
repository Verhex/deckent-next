import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { parseProviderSpendAccountQuery, type ProviderSpendExactAccountQuery } from '#domain/index.js';
import { parseProviderSpendAuditReceipt, verifyModelInvocationReceipt, ProviderSpendError, type ProviderSpendAccountReader, type ProviderSpendHoldPage } from '#engine/index.js';
import { PROVIDER_SPEND_AUDIT_LEDGER_VERSION, requireLedgerVersion, assertSqliteEngineSupported } from '#adapters/core/sqlite-ledger/index.js';
import { readSpendCheckpoint, decodeSpendReservation } from './spend-checkpoint.js';

const optionsSchema = z.object({ busyTimeoutMs: z.number().int().nonnegative().max(2_147_483_647) }).strict();

class SqliteProviderSpendAccountReader implements ProviderSpendAccountReader {
  constructor(private readonly db: DatabaseSync) {}

  async loadSnapshot(input: ProviderSpendExactAccountQuery) {
    let query: ProviderSpendExactAccountQuery;
    try { const parsed = parseProviderSpendAccountQuery(input); if ('current' in parsed) throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); query = parsed; }
    catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
    this.db.exec('BEGIN');
    try {
      const checkpoint = readSpendCheckpoint(this.db, query.scopeId);
      let holds: ProviderSpendHoldPage | undefined;
      if (query.holds) {
        requireLedgerVersion(this.db, 50);
        const page = query.holds;
        const rows = this.db.prepare(`SELECT s.record,s.digest,s.invocation_id,i.record AS invocation_record
          FROM model_invocation_spend_reservations s LEFT JOIN model_invocations i
          ON i.scope_id=s.scope_id AND i.invocation_id=s.invocation_id
          WHERE s.scope_id=? AND json_extract(s.record,'$.disposition.state')='held'
          AND json_extract(s.record,'$.reconciliation') IS NULL AND s.invocation_id COLLATE BINARY>?
          ORDER BY s.invocation_id COLLATE BINARY LIMIT ?`).all(query.scopeId, page.afterInvocationId ?? '', page.limit + 1);
        const entries = rows.map(row => {
          if (!checkpoint || typeof row.invocation_record !== 'string') throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
          const receipt = verifyModelInvocationReceipt(JSON.parse(row.invocation_record));
          const reservation = decodeSpendReservation(row, receipt, checkpoint, this.db);
          if (receipt.claim.invocationId !== row.invocation_id || reservation.disposition.state !== 'held' || reservation.reconciliation) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
          return { invocationId: reservation.descriptor.invocationId, amountMinorUnits: reservation.descriptor.quote.maxChargeMinorUnits,
            reason: reservation.disposition.reason, evidenceDigest: reservation.disposition.evidenceDigest };
        });
        holds = { entries: entries.slice(0, page.limit), nextAfterInvocationId: entries.length > page.limit ? entries[page.limit - 1]!.invocationId : null };
      }
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
      return Object.freeze({ checkpoint, audit, ...(holds ? { holds } : {}) });
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
    assertSqliteEngineSupported(process.versions.sqlite);
    const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new NativeDatabase(path, { readOnly: true, timeout: parsed.data.busyTimeoutMs });
    requireLedgerVersion(db, PROVIDER_SPEND_AUDIT_LEDGER_VERSION);
    return new SqliteProviderSpendAccountReader(db);
  } catch (error) {
    try { db?.close(); } catch { /* The read-only reader never wrote state. */ }
    if (error && typeof error === 'object' && 'code' in error
      && (error.code === 'ATTEMPT_STORE_VERSION' || error.code === 'ATTEMPT_STORE_SQLITE_UNSUPPORTED')) throw error;
    throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  }
}
