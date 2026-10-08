import type { DatabaseSync } from 'node:sqlite';
import type { ModelInvocationReceipt } from '#domain/index.js';
import { createProviderSpendCheckpoint, parseProviderSpendCheckpoint, verifyInvocationSpendReservation,
  providerSpendReservationDigest, providerSpendEvidenceDigest, parseProviderSpendManagementReceipt, type ProviderSpendManagementReceipt, ProviderSpendError, type ProviderSpendAccount, type ProviderSpendCheckpoint } from '#engine/index.js';

/** Fixed number of indexed row operations. History verification belongs to the separate read-only reader. */
export function readSpendCheckpoint(db: DatabaseSync, scopeId: string): ProviderSpendCheckpoint | null {
  const row = db.prepare('SELECT record,revision,reservation_count,digest FROM provider_spend_accounts WHERE scope_id=?').get(scopeId);
  if (!row) {
    if (db.prepare('SELECT 1 FROM model_invocation_spend_reservations WHERE scope_id=? LIMIT 1').get(scopeId)) {
      throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    }
    return null;
  }
  if (typeof row.record !== 'string') throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const checkpoint = parseProviderSpendCheckpoint({ schemaVersion: 2, revision: row.revision,
    reservationCount: row.reservation_count, digest: row.digest, account: JSON.parse(row.record) });
  if (checkpoint.account.budget.scopeId !== scopeId) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const account = checkpoint.account;
  if (account.budgetRevisionCommandId) {
    const row = db.prepare('SELECT record,digest FROM provider_spend_management WHERE scope_id=? AND command_id=?')
      .get(scopeId, account.budgetRevisionCommandId);
    if (!row || typeof row.record !== 'string') throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    const receipt = parseProviderSpendManagementReceipt(JSON.parse(row.record) as ProviderSpendManagementReceipt);
    if (row.digest !== receipt.digest || (receipt.command.kind !== 'budget-revision' && receipt.command.kind !== 'budget-create')
      || JSON.stringify(receipt.after.budget) !== JSON.stringify(account.budget)
      || providerSpendEvidenceDigest(receipt.command) !== account.budgetRevisionDigest
      || receipt.after.unfrozenAtBudgetRevision !== account.unfrozenAtBudgetRevision) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  }
  return checkpoint;
}
export function writeSpendCheckpoint(db: DatabaseSync, previous: ProviderSpendCheckpoint | null, account: ProviderSpendAccount, newReservation: boolean): void {
  if (!db.isTransaction) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  const next = createProviderSpendCheckpoint(account, (previous?.revision ?? 0) + 1,
    (previous?.reservationCount ?? 0) + (newReservation ? 1 : 0));
  const record = JSON.stringify(next.account), scopeId = account.budget.scopeId;
  if (previous) {
    const result = db.prepare(`UPDATE provider_spend_accounts SET record=?,revision=?,reservation_count=?,digest=?
      WHERE scope_id=? AND revision=? AND digest=?`).run(record, next.revision, next.reservationCount, next.digest,
      scopeId, previous.revision, previous.digest);
    if (result.changes !== 1) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  } else db.prepare('INSERT INTO provider_spend_accounts(scope_id,record,revision,reservation_count,digest) VALUES(?,?,?,?,?)')
    .run(scopeId, record, next.revision, next.reservationCount, next.digest);
}
export { providerSpendOutcomeDigest as spendOutcomeDigest } from '#engine/index.js';
export function decodeSpendReservation(row: { record?: unknown; digest?: unknown }, receipt: ModelInvocationReceipt, checkpoint: ProviderSpendCheckpoint, db?: DatabaseSync) {
  if (typeof row.record !== 'string') throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const reservation = verifyInvocationSpendReservation(JSON.parse(row.record), receipt), d = reservation.descriptor, budget = checkpoint.account.budget;
  if (row.digest !== providerSpendReservationDigest(reservation) || d.scopeId !== budget.scopeId || d.budgetId !== budget.budgetId
    || d.budgetRevision > budget.revision || d.currency !== budget.currency || receipt.claim.scopeId !== d.scopeId
    || receipt.claim.invocationId !== d.invocationId || receipt.claim.requestDigest !== d.quote.requestDigest
    || receipt.claim.profileDigest !== d.quote.profileDigest) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  if (reservation.reconciliation) {
    if (!db) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    const correction = reservation.reconciliation;
    const row = db.prepare('SELECT record,digest FROM provider_spend_management WHERE scope_id=? AND command_id=?')
      .get(d.scopeId, correction.commandId);
    if (!row || typeof row.record !== 'string') throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    const receipt = parseProviderSpendManagementReceipt(JSON.parse(row.record) as ProviderSpendManagementReceipt), command = receipt.command;
    if (receipt.digest !== row.digest || receipt.digest !== correction.receiptDigest || command.kind !== 'reconcile'
      || command.invocationId !== d.invocationId || command.scopeId !== d.scopeId || command.budgetRevision !== correction.budgetRevision || command.resolution !== correction.resolution
      || command.exactMinorUnits !== correction.exactMinorUnits || command.evidence.kind !== correction.evidenceKind
      || command.evidence.digest !== correction.evidenceDigest) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  }
  return reservation;
}
