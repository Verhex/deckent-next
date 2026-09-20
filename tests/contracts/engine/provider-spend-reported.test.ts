import { expect, it } from 'vitest';
import { addProviderSpendExactMinorUnits, canonicalProviderSpendExactMinorUnits, ceilProviderSpendExactMinorUnits,
  createProviderSpendAccount, createProviderSpendCheckpoint, parseProviderSpendReportedMeasurement,
  parseProviderSpendReservation, providerSpendEvidenceDigest, providerSpendExactFromNumericSource,
  providerSpendQuoteDigest, reserveProviderSpend, settleProviderSpend, verifyProviderSpendIntegrity,
  type ProviderSpendAccount, type ProviderSpendReportedMeasurement, type ProviderSpendReservation } from '#engine/core/provider-spend/index.js';

const digest = (character: string) => character.repeat(64);
const pricingDefinition = { schemaVersion: 1, kind: 'reported-test-price' };
const meterEvidence = { schemaVersion: 1, kind: 'reported-test-meter' };
const pricingDigest = providerSpendEvidenceDigest(pricingDefinition), meterDigest = providerSpendEvidenceDigest(meterEvidence);
const budget = { schemaVersion: 1, scopeId: 'scope', budgetId: 'reported', revision: 1, currency: 'USD', limitMinorUnits: 1000 };

function descriptor(invocationId: string, maximum = 2) {
  const quote = { schemaVersion: 1, scopeId: 'scope', requestDigest: digest('a'), profileDigest: digest('b'),
    pricing: { id: 'tariff', version: 1, digest: pricingDigest, definition: pricingDefinition },
    meter: { id: 'native-usage', version: 1, evidenceDigest: meterDigest, evidence: meterEvidence },
    currency: 'USD', maxChargeMinorUnits: maximum };
  return { schemaVersion: 1, scopeId: 'scope', invocationId, budgetId: 'reported', budgetRevision: 1,
    currency: 'USD', quoteDigest: providerSpendQuoteDigest(quote), quote };
}
function measurement(d: ReturnType<typeof descriptor>, numericSource = '0.0002', factor = 100): ProviderSpendReportedMeasurement {
  const exactMinorUnits = providerSpendExactFromNumericSource(numericSource, factor);
  return parseProviderSpendReportedMeasurement({ schemaVersion: 1, basis: 'provider-reported', currency: 'USD',
    exactMinorUnits, roundedMinorUnits: ceilProviderSpendExactMinorUnits(exactMinorUnits), quoteDigest: d.quoteDigest,
    requestDigest: d.quote.requestDigest, profileDigest: d.quote.profileDigest, responseContentDigest: digest('c'),
    source: { id: 'openrouter-native-usage', version: 1, field: 'usage.cost', generationId: 'generation', modelId: 'model',
      numericSource, minorUnitsPerCurrencyUnit: factor, bodyDigest: digest('d'), responseDigest: digest('e'),
      requestBodyDigest: digest('f'), tariffDigest: d.quote.pricing.digest, selectedEndpointTag: 'primary' } });
}

it('accumulates repeated microcharges exactly before projecting the account ceiling', () => {
  let account = createProviderSpendAccount(budget);
  for (let index = 0; index < 50; index++) {
    const d = descriptor(`micro-${index}`, 1), reserved = reserveProviderSpend(account, budget, d);
    const settled = settleProviderSpend(reserved.account, reserved.reservation,
      { kind: 'provider-reported', measurement: measurement(d), evidenceDigest: digest('9') });
    account = settled.account;
    expect(settled.reservation.disposition).toMatchObject({ state: 'settled-provider-reported', amountMinorUnits: 1 });
  }
  expect(account).toMatchObject({ settledExactMinorUnits: '1', settledMinorUnits: 1, reservedMinorUnits: 0 });
});

it('keeps integer local measurement distinct while combining it with exact reported cost', () => {
  let account = createProviderSpendAccount(budget);
  const localDescriptor = descriptor('local', 10), local = reserveProviderSpend(account, budget, localDescriptor);
  account = settleProviderSpend(local.account, local.reservation,
    { kind: 'measured-local', amountMinorUnits: 2, evidenceDigest: digest('1') }).account;
  const reportedDescriptor = descriptor('reported', 2), reported = reserveProviderSpend(account, budget, reportedDescriptor);
  const result = settleProviderSpend(reported.account, reported.reservation,
    { kind: 'provider-reported', measurement: measurement(reportedDescriptor, '0.004', 100), evidenceDigest: digest('2') });
  expect(result.account).toMatchObject({ settledExactMinorUnits: '2.4', settledMinorUnits: 3 });
  expect(result.reservation.measurement?.basis).toBe('provider-reported');
});

it('retains full reported evidence and freezes the account on an overrun', () => {
  const d = descriptor('overrun', 2), reserved = reserveProviderSpend(createProviderSpendAccount(budget), budget, d);
  const reported = measurement(d, '0.025', 100);
  const held = settleProviderSpend(reserved.account, reserved.reservation,
    { kind: 'provider-reported', measurement: reported, evidenceDigest: digest('3') });
  expect(held.account).toMatchObject({ frozen: true, reservedMinorUnits: 2, settledExactMinorUnits: '0' });
  expect(held.reservation).toMatchObject({ measurement: reported,
    disposition: { state: 'held', reason: 'overrun', observedMinorUnits: 3 } });
  expect(() => settleProviderSpend(held.account, held.reservation,
    { kind: 'not-sent', evidenceDigest: digest('3') })).toThrow('PROVIDER_SPEND_CONFLICT');
});

it('rejects corrupt source arithmetic, correlation, noncanonical values and precision or range overflow', () => {
  const d = descriptor('corruption'), valid = measurement(d);
  for (const corrupt of [
    { ...valid, exactMinorUnits: '0.03' },
    { ...valid, roundedMinorUnits: 0 },
    { ...valid, exactMinorUnits: '00.02' },
    { ...valid, source: { ...valid.source, numericSource: '-0.1' } },
    { ...valid, source: { ...valid.source, numericSource: `0.${'1'.repeat(257)}` } },
    { ...valid, source: { ...valid.source, numericSource: '9e256' } },
  ]) expect(() => parseProviderSpendReportedMeasurement(corrupt)).toThrow('PROVIDER_SPEND_INVALID');
  const reserved = reserveProviderSpend(createProviderSpendAccount(budget), budget, d);
  for (const mismatch of [{ ...valid, quoteDigest: digest('0') }, { ...valid, requestDigest: digest('0') },
    { ...valid, profileDigest: digest('0') }, { ...valid, currency: 'EUR' },
    { ...valid, source: { ...valid.source, tariffDigest: digest('0') } }]) {
    expect(() => settleProviderSpend(reserved.account, reserved.reservation,
      { kind: 'provider-reported', measurement: mismatch, evidenceDigest: digest('4') })).toThrow('PROVIDER_SPEND_CONFLICT');
  }
  expect(() => canonicalProviderSpendExactMinorUnits('1.0')).toThrow('PROVIDER_SPEND_INVALID');
  expect(() => addProviderSpendExactMinorUnits(String(Number.MAX_SAFE_INTEGER), '0.1')).toThrow('PROVIDER_SPEND_INVALID');
});

it('accepts reordered strict source fields but rejects unknown passthrough data', () => {
  const d = descriptor('ordering'), valid = measurement(d);
  const reordered = { ...valid, source: { selectedEndpointTag: valid.source.selectedEndpointTag,
    tariffDigest: valid.source.tariffDigest, requestBodyDigest: valid.source.requestBodyDigest,
    responseDigest: valid.source.responseDigest, bodyDigest: valid.source.bodyDigest,
    minorUnitsPerCurrencyUnit: valid.source.minorUnitsPerCurrencyUnit, numericSource: valid.source.numericSource,
    modelId: valid.source.modelId, generationId: valid.source.generationId, field: valid.source.field,
    version: valid.source.version, id: valid.source.id } };
  expect(parseProviderSpendReportedMeasurement(reordered)).toEqual(valid);
  expect(() => parseProviderSpendReportedMeasurement({ ...valid, cost_details: {} })).toThrow('PROVIDER_SPEND_INVALID');
  expect(() => parseProviderSpendReservation({ schemaVersion: 2, descriptor: d,
    disposition: { state: 'reserved' }, measurement: valid })).toThrow('PROVIDER_SPEND_INVALID');
});

it('freezes parsed reservations and rejects oversized or non-JSON numeric lexemes before arithmetic', () => {
  const d = descriptor('bounded-parser'), reserved = reserveProviderSpend(createProviderSpendAccount(budget), budget, d);
  expect(Object.isFrozen(parseProviderSpendReservation(reserved.reservation))).toBe(true);
  const huge = '9'.repeat(10_000);
  expect(() => canonicalProviderSpendExactMinorUnits(huge)).toThrow('PROVIDER_SPEND_INVALID');
  expect(() => addProviderSpendExactMinorUnits('0', huge)).toThrow('PROVIDER_SPEND_INVALID');
  expect(() => ceilProviderSpendExactMinorUnits(huge)).toThrow('PROVIDER_SPEND_INVALID');
  expect(() => parseProviderSpendReportedMeasurement({ ...measurement(d),
    source: { ...measurement(d).source, numericSource: '01' } })).toThrow('PROVIDER_SPEND_INVALID');
});

it('audits mixed exact and integer settlements against both exact and projected account totals', async () => {
  let account: ProviderSpendAccount = createProviderSpendAccount(budget);
  const reservations: ProviderSpendReservation[] = [];
  const localD = descriptor('a-local', 4), localR = reserveProviderSpend(account, budget, localD);
  const local = settleProviderSpend(localR.account, localR.reservation,
    { kind: 'measured-local', amountMinorUnits: 2, evidenceDigest: digest('5') });
  account = local.account; reservations.push(local.reservation);
  const reportD = descriptor('b-reported', 4), reportR = reserveProviderSpend(account, budget, reportD);
  const report = settleProviderSpend(reportR.account, reportR.reservation,
    { kind: 'provider-reported', measurement: measurement(reportD, '0.004', 100), evidenceDigest: digest('6') });
  account = report.account; reservations.push(report.reservation);
  const checkpoint = createProviderSpendCheckpoint(account, 2, 2);
  const reader = { async readPage() { return { checkpoint, reservations, nextInvocationId: null }; }, close() {} };
  await expect(verifyProviderSpendIntegrity(reader, 'scope', 2)).resolves.toMatchObject(
    { settledExactMinorUnits: '2.4', settledMinorUnits: 3, reservedMinorUnits: 0 });
  const corruptCheckpoint = createProviderSpendCheckpoint({ ...account, settledExactMinorUnits: '3', settledMinorUnits: 3 }, 2, 2);
  await expect(verifyProviderSpendIntegrity({ ...reader, async readPage() {
    return { checkpoint: corruptCheckpoint, reservations, nextInvocationId: null };
  } }, 'scope', 2)).rejects.toThrow('PROVIDER_SPEND_INVALID');
});
