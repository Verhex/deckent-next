import { checkModelInvocationCapacity } from '#engine/index.js';
import { expect, it } from 'vitest';
import { createProviderSpendAccount, parseProviderSpendAccount, reserveProviderSpend, assertProviderSpendCapacity, settleProviderSpend, providerSpendEvidenceDigest, providerSpendQuoteDigest, providerSpendLocalZeroTariff } from '#engine/core/provider-spend/index.js';

const budget = { schemaVersion: 1, scopeId: 'scope', budgetId: 'shared', revision: 1, currency: 'USD', limitMinorUnits: 100 };
const pricingDefinition = { schemaVersion: 1, kind: 'synthetic-price' }, meterEvidence = { schemaVersion: 1, kind: 'synthetic-meter' };
const evidenceDigest = providerSpendEvidenceDigest(meterEvidence), pricingDigest = providerSpendEvidenceDigest(pricingDefinition);
function descriptor(invocationId: string, maximum = 60) {
  const quote = { schemaVersion: 1, scopeId: 'scope', requestDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
      pricing: { id: 'price', version: 1, digest: pricingDigest, definition: pricingDefinition }, meter: { id: 'fixture-meter', version: 1, evidenceDigest, evidence: meterEvidence },
      currency: 'USD', maxChargeMinorUnits: maximum };
  return { schemaVersion: 1, scopeId: 'scope', invocationId, budgetId: 'shared', budgetRevision: 1, currency: 'USD',
    quoteDigest: providerSpendQuoteDigest(quote), quote };
}

it('verifies both pinned evidence documents before reserving and rejects digest-only quotes', () => {
  const original = descriptor('evidence');
  // Hashes without the original definition cannot reconstruct historical pricing.
  const missing = { ...original.quote, pricing: { id: 'price', version: 1, digest: pricingDigest } };
  expect(() => providerSpendQuoteDigest(missing)).toThrow();
  for (const changed of [
    { ...original.quote, pricing: { ...original.quote.pricing, definition: { ...pricingDefinition, kind: 'changed' } } },
    { ...original.quote, meter: { ...original.quote.meter, evidence: { ...meterEvidence, kind: 'changed' } } },
  ]) {
    expect(() => providerSpendQuoteDigest(changed)).toThrow('PROVIDER_SPEND_INVALID');
    expect(() => reserveProviderSpend(createProviderSpendAccount(budget), budget,
      { ...original, quote: changed })).toThrow('PROVIDER_SPEND_INVALID');
  }
  expect(providerSpendEvidenceDigest({ b: 2, a: 1 })).toBe(providerSpendEvidenceDigest({ a: 1, b: 2 }));
});

it('shares account arithmetic across distinct profile quotes and rejects changing account identity or limits', () => {
  const first = reserveProviderSpend(createProviderSpendAccount(budget), budget, descriptor('one'));
  const other = descriptor('two'); other.quote.profileDigest = 'f'.repeat(64); other.quote.pricing.id = 'other-provider';
  other.quoteDigest = providerSpendQuoteDigest(other.quote);
  expect(() => reserveProviderSpend(first.account, budget, other)).toThrow('PROVIDER_SPEND_EXHAUSTED');
  for (const change of [{ budgetId: 'new' }, { revision: 2 }, { limitMinorUnits: 200 }, { currency: 'EUR' }, { scopeId: 'other' }]) {
    expect(() => reserveProviderSpend(first.account, { ...budget, ...change }, descriptor('next'))).toThrow('PROVIDER_SPEND_CONFLICT');
  }
  expect(createProviderSpendAccount({ ...budget, scopeId: 'other' }).reservedMinorUnits).toBe(0);
});

it('releases only proven not-sent and settles measured local cost without asserting invoice truth', () => {
  const first = reserveProviderSpend(createProviderSpendAccount(budget), budget, descriptor('one'));
  const released = settleProviderSpend(first.account, first.reservation, { kind: 'not-sent', evidenceDigest });
  expect(released.account).toMatchObject({ reservedMinorUnits: 0, settledMinorUnits: 0 });
  expect(released.reservation.disposition.state).toBe('released-not-sent');
  const measured = settleProviderSpend(first.account, first.reservation, { kind: 'measured-local', amountMinorUnits: 17, evidenceDigest });
  expect(measured.account).toMatchObject({ reservedMinorUnits: 0, settledMinorUnits: 17 });
  expect(measured.reservation.disposition).toEqual({ state: 'settled-local', amountMinorUnits: 17, evidenceDigest });
  expect(() => settleProviderSpend(measured.account, measured.reservation, { kind: 'not-sent', evidenceDigest })).toThrow('PROVIDER_SPEND_CONFLICT');
});

it.each(['unknown', 'missing-usage', 'invalid-usage', 'price-unavailable'])('holds the whole reservation for %s', reason => {
  const first = reserveProviderSpend(createProviderSpendAccount(budget), budget, descriptor('one'));
  const held = settleProviderSpend(first.account, first.reservation, { kind: 'hold', reason, evidenceDigest });
  expect(held.account).toEqual(first.account); expect(held.reservation.disposition.state).toBe('held');
  expect(() => reserveProviderSpend(held.account, budget, descriptor('two'))).toThrow('PROVIDER_SPEND_EXHAUSTED');
  expect(() => settleProviderSpend(held.account, held.reservation, { kind: 'not-sent', evidenceDigest })).toThrow('PROVIDER_SPEND_CONFLICT');
});

it('freezes further admissions on an observed overrun without inventing a capped charge', () => {
  const first = reserveProviderSpend(createProviderSpendAccount(budget), budget, descriptor('one', 20));
  const held = settleProviderSpend(first.account, first.reservation, { kind: 'measured-local', amountMinorUnits: 25, evidenceDigest });
  expect(held.account).toMatchObject({ frozen: true, reservedMinorUnits: 20, settledMinorUnits: 0 });
  expect(held.reservation.disposition).toMatchObject({ state: 'held', reason: 'overrun', observedMinorUnits: 25 });
  expect(() => reserveProviderSpend(held.account, budget, descriptor('two', 1))).toThrow('PROVIDER_SPEND_FROZEN');
});

it('uses exact safe integer arithmetic at the limit and rejects corrupt totals and accessor inputs', () => {
  const maximum = Number.MAX_SAFE_INTEGER, configured = { ...budget, limitMinorUnits: maximum };
  const first = reserveProviderSpend(createProviderSpendAccount(configured), configured, descriptor('one', maximum));
  expect(() => reserveProviderSpend(first.account, configured, descriptor('two', 1))).toThrow('PROVIDER_SPEND_EXHAUSTED');
  const final = settleProviderSpend(first.account, first.reservation, { kind: 'measured-local', amountMinorUnits: maximum, evidenceDigest });
  expect(final.account.settledMinorUnits).toBe(maximum);
  expect(() => parseProviderSpendAccount({ ...final.account, reservedMinorUnits: 1 })).toThrow('PROVIDER_SPEND_INVALID');
  let invoked = false;
  const accessor = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { invoked = true; return 1; } });
  expect(() => parseProviderSpendAccount(accessor)).toThrow('PROVIDER_SPEND_INVALID'); expect(invoked).toBe(false);
});

// SECURITY-FIX (commit review of 9c8392e3): an integrity freeze is checked before any zero-tariff shortcut, and the budget-less
// preview opens the scope account to see that freeze; only exhaustion arithmetic is skipped for a literal zero quote.
it.each([true, false])('a verified zero tariff never passes a frozen account (frozen=%s); it only skips exhaustion of a revised limit', async frozen => {
  const d = descriptor('zero', 0), free = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 };
  const quote = { ...d.quote, pricing: { id: 'operator-static-tariff', version: 1, definition: free, digest: providerSpendEvidenceDigest(free) } };
  const account = { ...createProviderSpendAccount(budget), settledMinorUnits: 101, settledExactMinorUnits: '101', frozen,
    budgetRevisionDigest: 'a'.repeat(64), budgetRevisionCommandId: 'lower-budget' };
  if (frozen) expect(() => assertProviderSpendCapacity(account, quote)).toThrow('PROVIDER_SPEND_FROZEN');
  else expect(() => assertProviderSpendCapacity(account, quote)).not.toThrow();
  const reader = { async loadSnapshot() { return { checkpoint: { account }, audit: null }; }, close() {} } as never;
  const preview = checkModelInvocationCapacity(async () => reader, { budget: null, quote });
  if (frozen) await expect(preview).rejects.toThrow('PROVIDER_SPEND_FROZEN'); else await expect(preview).resolves.toBeUndefined();
  await expect(checkModelInvocationCapacity(async () => { throw new Error('money-reader-must-not-open'); }, { budget: null, quote: descriptor('paid', 0).quote }))
    .rejects.toThrow('PROVIDER_SPEND_INVALID');
  expect(() => assertProviderSpendCapacity(account, descriptor('paid', 1).quote)).toThrow(frozen ? 'PROVIDER_SPEND_FROZEN' : 'PROVIDER_SPEND_EXHAUSTED');
});

it('exempts only a literal zero tariff whose every declared endpoint is a literal loopback IP (PROVIDER-LOCALITY)', () => {
  const free = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 };
  const zero = { ...descriptor('zero', 0).quote, pricing: { id: 'operator-static-tariff', version: 1, definition: free, digest: providerSpendEvidenceDigest(free) } };
  const profile = (definition: Record<string, unknown>) => ({ adapter: { id: 'openai-chat-http', version: 4, definition } }) as never;
  for (const endpoint of ['http://127.0.0.1:8000/v1/chat/completions', 'http://[::1]:11434/v1/chat/completions']) {
    expect(providerSpendLocalZeroTariff(profile({ endpoint }), zero)).toBe(true);
    expect(providerSpendLocalZeroTariff(profile({ endpoint, tokenizeEndpoint: endpoint.replace('v1/chat/completions', 'tokenize') }), zero)).toBe(true);
  }
  for (const endpoint of ['http://localhost:8000/v1/chat/completions', 'http://192.168.1.20:8000/v1/chat/completions', 'http://172.28.160.1:8000/v1/chat/completions',
    'https://api.deepseek.com/chat/completions', 'http://127.0.0.1.nip.io/v1/chat/completions', 'not a url']) {
    expect(providerSpendLocalZeroTariff(profile({ endpoint }), zero)).toBe(false);
  }
  expect(providerSpendLocalZeroTariff(profile({ endpoint: 'http://127.0.0.1:8000/chat', tokenizeEndpoint: 'http://localhost:8000/tokenize' }), zero)).toBe(false);
  expect(providerSpendLocalZeroTariff(profile({ origin: 'http://127.0.0.1:8000' }), zero)).toBe(false);
  // A numeric zero without a literal zero tariff is not local-free either.
  expect(providerSpendLocalZeroTariff(profile({ endpoint: 'http://127.0.0.1:8000/chat' }), descriptor('paid', 0).quote)).toBe(false);
});
