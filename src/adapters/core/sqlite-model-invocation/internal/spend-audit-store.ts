import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { identitySchema } from '#domain/index.js';
import { parseProviderSpendAuditReceipt, ProviderSpendError, type ProviderSpendAuditReceipt,
  type ProviderSpendAuditResult, type ProviderSpendAuditStore, type SupervisorProfileValidator } from '#engine/index.js';
import { openSqliteLedger, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { readSpendCheckpoint } from './spend-checkpoint.js';

/** No full-history work occurs under this short write transaction. The application owns the scan. */
class SqliteProviderSpendAuditStore implements ProviderSpendAuditStore {
  constructor(private readonly db: DatabaseSync) {}
  private read(scopeId: string, commandId: string): ProviderSpendAuditReceipt | null {
    const row = this.db.prepare(`SELECT scope_id,budget_id,budget_revision,command_id,record,digest
      FROM provider_spend_audits WHERE scope_id=? AND command_id=?`).get(scopeId, commandId);
    if (!row) return null;
    if (typeof row.record !== 'string') throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    let receipt: ProviderSpendAuditReceipt;
    try { receipt = parseProviderSpendAuditReceipt(JSON.parse(row.record)); }
    catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
    if (receipt.digest !== row.digest || receipt.command.scopeId !== scopeId || receipt.command.commandId !== commandId
      || receipt.command.scopeId !== row.scope_id || receipt.command.budgetId !== row.budget_id
      || receipt.command.budgetRevision !== row.budget_revision || receipt.command.commandId !== row.command_id) {
      throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    }
    return receipt;
  }
  async find(scopeId: string, commandId: string) {
    if (!identitySchema.safeParse(scopeId).success || !identitySchema.safeParse(commandId).success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    try { return this.read(scopeId, commandId); }
    catch (error) {
      if (error instanceof ProviderSpendError) throw error;
      throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
    }
  }
  async record(input: ProviderSpendAuditReceipt, signal?: AbortSignal): Promise<ProviderSpendAuditResult> {
    if (signal?.aborted) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
    const receipt = parseProviderSpendAuditReceipt(input), command = receipt.command;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const prior = this.read(command.scopeId, command.commandId);
      if (prior) {
        if (!isDeepStrictEqual(prior.command, command) || !isDeepStrictEqual(prior.actor, receipt.actor)) {
          throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
        }
        this.db.exec('COMMIT');
        return Object.freeze({ schemaVersion: 1, receipt: prior, replayed: true });
      }
      const current = readSpendCheckpoint(this.db, command.scopeId);
      if (!current || current.digest !== receipt.examinedCheckpoint.digest) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
      if (signal?.aborted) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
      this.db.prepare(`INSERT INTO provider_spend_audits
        (scope_id,budget_id,budget_revision,command_id,record,digest) VALUES(?,?,?,?,?,?)`)
        .run(command.scopeId, command.budgetId, command.budgetRevision, command.commandId, JSON.stringify(receipt), receipt.digest);
      this.db.exec('COMMIT');
      return Object.freeze({ schemaVersion: 1, receipt, replayed: false });
    } catch (error) {
      try { if (this.db.isTransaction) this.db.exec('ROLLBACK'); }
      catch { throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE'); }
      if (error instanceof ProviderSpendError) throw error;
      // A failed COMMIT response does not prove rollback; same-command replay checks durable truth.
      throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
    }
  }
  close() { this.db.close(); }
}
export function openSqliteProviderSpendAuditStore(path: string, options: SqliteLedgerOptions,
  migrationMode: 'allow' | 'forbid' = 'allow', profiles?: SupervisorProfileValidator): ProviderSpendAuditStore {
  try { return new SqliteProviderSpendAuditStore(openSqliteLedger(path, options, migrationMode, profiles)); }
  catch { throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE'); }
}
