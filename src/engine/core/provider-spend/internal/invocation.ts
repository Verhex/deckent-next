import { providerSpendHasZeroTariff } from './no-charge.js';
import { createHash } from 'node:crypto';
import type { ModelInvocationReceipt } from '#domain/index.js';
import { parseProviderSpendReservation, providerSpendQuoteDigest } from './account.js';
import { ProviderSpendError } from './error.js';

/** A complete admission rejection, never a 2xx parse failure, timeout, conflict or interrupted body. */
export function providerSpendRejectionHasNoCharge(outcome: ModelInvocationReceipt['outcome']): boolean {
  if (outcome?.state !== 'rejected' || !outcome.evidence.body.complete) return false;
  const evidence = outcome.evidence;
  if (evidence.reason === 'not-sent') return evidence.httpStatus === null && evidence.body.observedBytes === 0;
  return evidence.reason === 'http-status' && evidence.httpStatus !== null
    && [400, 401, 402, 403, 404, 405, 406, 407, 410, 411, 412, 413, 414, 415, 416, 417, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451].includes(evidence.httpStatus);
}

export function providerSpendOutcomeDigest(receipt: ModelInvocationReceipt): string {
  return createHash('sha256').update(`deckent.provider-spend-outcome.v1\n${JSON.stringify(receipt.outcome)}`).digest('hex');
}
/** Only the queried invocation's pinned financial evidence is exposed; no shared account totals. */
export function verifyInvocationSpendReservation(input: unknown, receipt: ModelInvocationReceipt) {
  const reservation = parseProviderSpendReservation(input), d = reservation.descriptor, state = reservation.disposition, outcome = receipt.outcome;
  if (d.scopeId !== receipt.claim.scopeId || d.invocationId !== receipt.claim.invocationId
    || d.quote.requestDigest !== receipt.claim.requestDigest || d.quote.profileDigest !== receipt.claim.profileDigest
    || d.quoteDigest !== providerSpendQuoteDigest(d.quote)) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  if (state.state === 'reserved' ? outcome !== null : outcome === null
    || state.evidenceDigest !== providerSpendOutcomeDigest(receipt)
    || (state.state === 'released-not-sent' ? outcome.state !== 'not-sent' : outcome.state === 'not-sent')
    || (state.state === 'released-no-charge' && !providerSpendRejectionHasNoCharge(outcome))
    || (reservation.recovery && state.state === 'settled-local' && !providerSpendHasZeroTariff(d.quote))
    || (state.state === 'settled-local' && outcome.state === 'unknown' && !(reservation.schemaVersion === 5 && providerSpendHasZeroTariff(d.quote)))
    || ((state.state === 'settled-provider-reported' || state.state === 'settled-measured-tariff') && ((outcome.state !== 'responded' && outcome.state !== 'unknown')
      || state.amountMinorUnits !== reservation.measurement?.roundedMinorUnits
      || outcome.content?.digest !== reservation.measurement.responseContentDigest))
    || (state.state === 'held' && state.reason === 'overrun' && reservation.measurement !== null
      && ((outcome.state !== 'responded' && outcome.state !== 'unknown') || outcome.content?.digest !== reservation.measurement.responseContentDigest))) {
    throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  }
  return reservation;
}
