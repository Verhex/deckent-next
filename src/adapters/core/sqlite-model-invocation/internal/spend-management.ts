import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { ProviderSpendManagementCommand, ModelInvocationActor, ModelInvocationAuthorization } from '#domain/index.js';
import { ProviderSpendError, providerSpendEvidenceDigest, parseProviderSpendManagementReceipt, reconcileProviderSpend,
  reviseProviderSpendBudget, createGovernedProviderSpendAccount, providerSpendReservationDigest, verifyModelInvocationReceipt,
  type ProviderSpendManagementStore, type ProviderSpendManagementReceipt, type ProviderSpendManagementResult } from '#engine/index.js';
import { openSqliteLedger, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { readSpendCheckpoint, writeSpendCheckpoint, decodeSpendReservation } from './spend-checkpoint.js';
class SqliteProviderSpendManagementStore implements ProviderSpendManagementStore {
  constructor(private readonly db: DatabaseSync) {}
  async apply(command: ProviderSpendManagementCommand, actor: ModelInvocationActor, authorization: ModelInvocationAuthorization,
    recordedAtMs: number, maxResultBytes: number): Promise<ProviderSpendManagementResult> {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const prior = this.db.prepare('SELECT record,digest FROM provider_spend_management WHERE scope_id=? AND command_id=?').get(command.scopeId, command.commandId);
      if (prior) {
        if (typeof prior.record !== 'string') throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
        const receipt = parseProviderSpendManagementReceipt(JSON.parse(prior.record) as ProviderSpendManagementReceipt);
        if (receipt.digest !== prior.digest || !isDeepStrictEqual(receipt.command, command) || !isDeepStrictEqual(receipt.actor, actor)) {
          throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
        }
        if (Buffer.byteLength(JSON.stringify({ receipt, replayed: true })) > maxResultBytes) throw new ProviderSpendError('PROVIDER_SPEND_RESULT_LIMIT');
        this.db.exec('COMMIT'); return Object.freeze({ receipt, replayed: true });
      }
      const before = readSpendCheckpoint(this.db, command.scopeId);
      if (command.kind === 'budget-create') return this.record(command, actor, authorization, recordedAtMs, maxResultBytes, before);
      if (!before || before.digest !== command.expectedCheckpointDigest || before.account.budget.budgetId !== command.budgetId
        || before.account.budget.revision !== command.budgetRevision) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
      const row = command.kind === 'reconcile' ? this.db.prepare(`SELECT s.record,s.digest,i.record AS invocation_record
        FROM model_invocation_spend_reservations s JOIN model_invocations i ON i.scope_id=s.scope_id AND i.invocation_id=s.invocation_id
        WHERE s.scope_id=? AND s.invocation_id=?`).get(command.scopeId, command.invocationId) : null;
      if (command.kind === 'reconcile' && (!row || typeof row.invocation_record !== 'string')) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
      const reservation = row ? decodeSpendReservation(row, verifyModelInvocationReceipt(JSON.parse(row.invocation_record as string)), before, this.db) : null;
      const after = command.kind === 'budget-revision' ? reviseProviderSpendBudget(before.account, command)
        : reconcileProviderSpend(before.account, reservation, command, '0'.repeat(64)).account;
      const body = { schemaVersion: 1 as const, command, actor, authorization, recordedAtMs, before, after };
      const receipt = parseProviderSpendManagementReceipt({ ...body, digest: providerSpendEvidenceDigest(body) });
      if (Buffer.byteLength(JSON.stringify({ receipt, replayed: false })) > maxResultBytes) throw new ProviderSpendError('PROVIDER_SPEND_RESULT_LIMIT');
      if (command.kind === 'reconcile' && row) {
        const next = reconcileProviderSpend(before.account, reservation, command, receipt.digest).reservation;
        const updated = this.db.prepare('UPDATE model_invocation_spend_reservations SET record=?,digest=? WHERE scope_id=? AND invocation_id=? AND digest=?')
          .run(JSON.stringify(next), providerSpendReservationDigest(next), command.scopeId, command.invocationId, row.digest!);
        if (updated.changes !== 1) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
      }
      return this.commit(before, receipt);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      if (error instanceof ProviderSpendError) throw error;
      throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
    }
  }
  /** Stage 1 `budget-create` (inside the caller's transaction): only a scope without any account; an existing one is changed by a revision. */
  private record(command: Extract<ProviderSpendManagementCommand, { kind: 'budget-create' }>, actor: ModelInvocationActor, authorization: ModelInvocationAuthorization,
    recordedAtMs: number, maxResultBytes: number, before: ReturnType<typeof readSpendCheckpoint>): ProviderSpendManagementResult {
    if (before) throw new ProviderSpendError('PROVIDER_SPEND_BUDGET_EXISTS');
    const body = { schemaVersion: 1 as const, command, actor, authorization, recordedAtMs, before: null, after: createGovernedProviderSpendAccount(command) };
    const receipt = parseProviderSpendManagementReceipt({ ...body, digest: providerSpendEvidenceDigest(body) });
    if (Buffer.byteLength(JSON.stringify({ receipt, replayed: false })) > maxResultBytes) throw new ProviderSpendError('PROVIDER_SPEND_RESULT_LIMIT');
    return this.commit(null, receipt);
  }
  private commit(before: ReturnType<typeof readSpendCheckpoint>, receipt: ProviderSpendManagementReceipt): ProviderSpendManagementResult {
    writeSpendCheckpoint(this.db, before, receipt.after, false);
    this.db.prepare('INSERT INTO provider_spend_management(scope_id,command_id,record,digest) VALUES(?,?,?,?)')
      .run(receipt.command.scopeId, receipt.command.commandId, JSON.stringify(receipt), receipt.digest);
    this.db.exec('COMMIT'); return Object.freeze({ receipt, replayed: false });
  }
  close() { this.db.close(); }
}
export function openSqliteProviderSpendManagementStore(path: string, options: SqliteLedgerOptions): ProviderSpendManagementStore {
  return new SqliteProviderSpendManagementStore(openSqliteLedger(path, options, 'forbid'));
}
