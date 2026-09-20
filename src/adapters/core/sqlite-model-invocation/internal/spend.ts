import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { createProviderSpendAccount, reserveProviderSpend, settleProviderSpend, providerSpendQuoteDigest,
  providerSpendReservationDigest, parseProviderSpendReportedMeasurement, ProviderSpendError,
  type ModelInvocationAdmission, type ModelInvocationRecord, type ProviderSpendReportedMeasurement } from '#engine/index.js';
import { readSpendCheckpoint, writeSpendCheckpoint, decodeSpendReservation, spendOutcomeDigest } from './spend-checkpoint.js';

function requiredTransaction(db: DatabaseSync) {
  if (!db.isTransaction) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
}
export function reserveInvocationSpend(db: DatabaseSync, admission: ModelInvocationAdmission): void {
  requiredTransaction(db);
  if (!admission.spending) return;
  const { budget, quote } = admission.spending;
  const current = readSpendCheckpoint(db, admission.command.scopeId), account = current?.account ?? createProviderSpendAccount(budget);
  const next = reserveProviderSpend(account, budget, { schemaVersion: 1, scopeId: admission.command.scopeId,
    invocationId: admission.invocationId, budgetId: budget.budgetId, budgetRevision: budget.revision, currency: budget.currency,
    quoteDigest: providerSpendQuoteDigest(quote), quote });
  writeSpendCheckpoint(db, current, next.account, true);
  db.prepare('INSERT INTO model_invocation_spend_reservations(scope_id,invocation_id,record,digest) VALUES(?,?,?,?)')
    .run(budget.scopeId, admission.invocationId, JSON.stringify(next.reservation), providerSpendReservationDigest(next.reservation));
}

/** Replay validates its exact reservation and checkpoint without scanning unrelated history. */
export function verifyInvocationSpendReplay(db: DatabaseSync, admission: ModelInvocationAdmission, record: ModelInvocationRecord): void {
  requiredTransaction(db);
  const row = db.prepare('SELECT record,digest FROM model_invocation_spend_reservations WHERE scope_id=? AND invocation_id=?')
    .get(record.receipt.claim.scopeId, record.receipt.claim.invocationId);
  if (!row) { if (admission.spending) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT'); return; }
  const checkpoint = readSpendCheckpoint(db, record.receipt.claim.scopeId);
  if (!checkpoint) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const reservation = decodeSpendReservation(row, record.receipt, checkpoint);
  if (admission.spending && (!isDeepStrictEqual(reservation.descriptor.quote, admission.spending.quote)
    || !isDeepStrictEqual(checkpoint.account.budget, admission.spending.budget))) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
}

function reservationRow(db: DatabaseSync, next: ModelInvocationRecord) {
  return db.prepare('SELECT record,digest FROM model_invocation_spend_reservations WHERE scope_id=? AND invocation_id=?')
    .get(next.receipt.claim.scopeId, next.receipt.claim.invocationId);
}
function checkedMeasurement(next: ModelInvocationRecord, input: ProviderSpendReportedMeasurement | null | undefined) {
  if (input == null) return null;
  const measurement = parseProviderSpendReportedMeasurement(input);
  if (next.receipt.outcome?.state !== 'responded' || next.content === null
    || measurement.responseContentDigest !== next.content.descriptor.digest) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  return measurement;
}

/** Validate a terminal replay against its persisted money evidence without changing either checkpoint. */
export function verifyInvocationSpendSettlementReplay(db: DatabaseSync, next: ModelInvocationRecord,
  input: ProviderSpendReportedMeasurement | null | undefined): void {
  requiredTransaction(db);
  const measurement = checkedMeasurement(next, input), row = reservationRow(db, next);
  if (!row) { if (measurement) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT'); return; }
  if (!measurement) return;
  const checkpoint = readSpendCheckpoint(db, next.receipt.claim.scopeId);
  if (!checkpoint) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const persisted = decodeSpendReservation(row, next.receipt, checkpoint);
  if (!isDeepStrictEqual(persisted.measurement, measurement)) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
}

/** The response, allocation and monetary transition share the caller's single transaction. */
export function settleInvocationSpend(db: DatabaseSync, next: ModelInvocationRecord,
  input: ProviderSpendReportedMeasurement | null | undefined = null): void {
  requiredTransaction(db);
  const measurement = checkedMeasurement(next, input);
  const claim = next.receipt.claim, outcome = next.receipt.outcome;
  const row = reservationRow(db, next);
  if (!row) { if (measurement) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT'); return; }
  if (!outcome) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const checkpoint = readSpendCheckpoint(db, claim.scopeId);
  if (!checkpoint) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const current = decodeSpendReservation(row, { ...next.receipt, outcome: null }, checkpoint);
  const evidenceDigest = spendOutcomeDigest(next.receipt);
  const result = settleProviderSpend(checkpoint.account, current, measurement
    ? { kind: 'provider-reported', measurement, evidenceDigest }
    : outcome.state === 'not-sent'
    ? { kind: 'not-sent', evidenceDigest }
    : { kind: 'hold', reason: outcome.state === 'unknown' || outcome.state === 'rejected' ? 'unknown' : 'missing-usage', evidenceDigest });
  writeSpendCheckpoint(db, checkpoint, result.account, false);
  const updated = db.prepare(`UPDATE model_invocation_spend_reservations SET record=?,digest=?
    WHERE scope_id=? AND invocation_id=? AND digest=?`).run(JSON.stringify(result.reservation), providerSpendReservationDigest(result.reservation),
      claim.scopeId, claim.invocationId, row.digest as string);
  if (updated.changes !== 1) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
}
