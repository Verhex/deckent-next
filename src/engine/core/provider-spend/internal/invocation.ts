import { createHash } from 'node:crypto';
import type { ModelInvocationReceipt } from '#domain/index.js';
import { parseProviderSpendReservation, providerSpendQuoteDigest } from './account.js';
import { ProviderSpendError } from './error.js';

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
    || ((state.state === 'settled-local' || state.state === 'settled-provider-reported') && outcome.state === 'unknown')
    || (state.state === 'settled-provider-reported' && (outcome.state !== 'responded'
      || state.amountMinorUnits !== reservation.measurement?.roundedMinorUnits
      || outcome.content.digest !== reservation.measurement.responseContentDigest))
    || (state.state === 'held' && state.reason === 'overrun' && reservation.measurement !== null
      && (outcome.state !== 'responded' || outcome.content.digest !== reservation.measurement.responseContentDigest))) {
    throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  }
  return reservation;
}
