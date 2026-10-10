import type { ModelInvocationReceipt } from '#domain/index.js';
import { parseProviderSpendAccount, parseProviderSpendReservation, providerSpendEvidenceDigest } from './account.js';
import { providerSpendReservationDigest } from './checkpoint.js';
import { providerSpendOutcomeDigest, verifyInvocationSpendReservation } from './invocation.js';
import { certifyProviderSpendNoCharge, providerSpendHasZeroTariff } from './no-charge.js';
import { ProviderSpendError } from './error.js';

export interface ProviderSpendRecoveryResult {
  readonly released: number; readonly zeroTariff: number;
  readonly inconsistent: readonly { readonly scopeId: string; readonly invocationId: string }[];
}
/** Internal startup port: no provider effects, operator impersonation or money expiry. */
export interface ProviderSpendRecoveryStore {
  recoverCertifiedHolds(recordedAtMs: number): Promise<ProviderSpendRecoveryResult>;
  close(): void;
}

/** Certified historical holds only. Preserve the prior row and an auditable release in reservation v5. */
export function recoverProviderSpendHold(accountInput: unknown, reservationInput: unknown, receipt: ModelInvocationReceipt, recordedAtMs: number) {
  const account = parseProviderSpendAccount(accountInput), reservation = verifyInvocationSpendReservation(reservationInput, receipt), d = reservation.descriptor;
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0 || d.scopeId !== account.budget.scopeId || d.budgetId !== account.budget.budgetId
    || d.budgetRevision > account.budget.revision || d.currency !== account.budget.currency) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  if (reservation.disposition.state !== 'held' || reservation.disposition.reason === 'overrun' || reservation.reconciliation || reservation.recovery) return null;
  const zeroTariff = providerSpendHasZeroTariff(d.quote);
  const certificationDigest = zeroTariff ? providerSpendEvidenceDigest({ schemaVersion: 1, kind: 'zero-tariff', quoteDigest: d.quoteDigest }) : certifyProviderSpendNoCharge(receipt);
  if (!certificationDigest) return null;
  if (account.reservedMinorUnits < d.quote.maxChargeMinorUnits) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const audit = { schemaVersion: 1 as const, recordedAtMs, previousSchemaVersion: reservation.schemaVersion,
    previousDisposition: reservation.disposition, previousDigest: providerSpendReservationDigest(reservation), certificationDigest };
  const evidenceDigest = providerSpendOutcomeDigest(receipt);
  return Object.freeze({ zeroTariff,
    account: parseProviderSpendAccount({ ...account, reservedMinorUnits: account.reservedMinorUnits - d.quote.maxChargeMinorUnits }),
    reservation: parseProviderSpendReservation({ ...reservation, schemaVersion: 5,
      disposition: zeroTariff ? { state: 'settled-local', amountMinorUnits: 0, evidenceDigest } : { state: 'released-no-charge', evidenceDigest },
      recovery: { ...audit, digest: providerSpendEvidenceDigest(audit) } }) });
}
