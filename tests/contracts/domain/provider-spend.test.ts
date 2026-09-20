import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseProviderSpendBudget, parseProviderSpendQuote, parseProviderSpendReservationDescriptor } from '#domain/core/provider-spend/index.js';

const digest = 'a'.repeat(64), otherDigest = 'b'.repeat(64);
const pricingDefinition = { schemaVersion: 1, kind: 'synthetic-price' }, meterEvidence = { schemaVersion: 1, kind: 'synthetic-meter' };
const evidenceDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const account = () => ({ schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1,
  currency: 'USD', limitMinorUnits: 10_000 });
const quote = () => ({ schemaVersion: 1, scopeId: 'scope', requestDigest: digest, profileDigest: otherDigest,
  pricing: { id: 'pricing', version: 1, digest: evidenceDigest(pricingDefinition), definition: { ...pricingDefinition } }, meter: { id: 'meter', version: 1, evidenceDigest: evidenceDigest(meterEvidence), evidence: { ...meterEvidence } },
  currency: 'USD', maxChargeMinorUnits: 250 });
const reservation = () => ({ schemaVersion: 1, scopeId: 'scope', invocationId: 'invocation', budgetId: 'budget',
  budgetRevision: 1, currency: 'USD', quoteDigest: digest, quote: quote() });

it('parses frozen structural spend records without assigning monetary authority', () => {
  const parsedAccount = parseProviderSpendBudget(account()), parsedQuote = parseProviderSpendQuote(quote()),
    parsedReservation = parseProviderSpendReservationDescriptor(reservation());
  expect(parsedAccount).toEqual(account()); expect(parsedQuote).toEqual(quote()); expect(parsedReservation).toEqual(reservation());
  expect(Object.isFrozen(parsedAccount)).toBe(true); expect(Object.isFrozen(parsedQuote)).toBe(true);
  expect(Object.isFrozen(parsedQuote.pricing)).toBe(true); expect(Object.isFrozen(parsedQuote.meter)).toBe(true);
  expect(Object.isFrozen(parsedReservation)).toBe(true); expect(Object.isFrozen(parsedReservation.quote)).toBe(true);
});

it('copies descriptor-safe input and rejects getters or custom prototypes', () => {
  let calls = 0; const hostile = account();
  Object.defineProperty(hostile, 'currency', { enumerable: true, get() { calls++; return 'USD'; } });
  expect(() => parseProviderSpendBudget(hostile)).toThrow(); expect(calls).toBe(0);
  const inherited = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, account());
  expect(() => parseProviderSpendBudget(inherited)).toThrow();

  const supplied = reservation(), parsed = parseProviderSpendReservationDescriptor(supplied);
  supplied.quote.pricing.id = 'changed'; supplied.quote.currency = 'EUR';
  expect(parsed.quote.pricing.id).toBe('pricing'); expect(parsed.quote.currency).toBe('USD');
});

it('copies nested evidence and rejects getter or oversized evidence documents', () => {
  const supplied = quote(), parsed = parseProviderSpendQuote(supplied);
  supplied.pricing.definition.kind = 'changed'; supplied.meter.evidence.kind = 'changed';
  expect(parsed.pricing.definition).toEqual(pricingDefinition); expect(parsed.meter.evidence).toEqual(meterEvidence);
  let calls = 0; const getter = quote(); Object.defineProperty(getter.pricing.definition, 'kind', { enumerable: true, get() { calls++; return 'forged'; } });
  expect(() => parseProviderSpendQuote(getter)).toThrow(); expect(calls).toBe(0);
  expect(() => parseProviderSpendQuote({ ...quote(), meter: { ...quote().meter, evidence: { text: 'x'.repeat(2_000_000) } } })).toThrow();
});

it('rejects negative, fractional, unsafe, and malformed monetary fields', () => {
  for (const limitMinorUnits of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parseProviderSpendBudget({ ...account(), limitMinorUnits })).toThrow();
  }
  for (const maxChargeMinorUnits of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parseProviderSpendQuote({ ...quote(), maxChargeMinorUnits })).toThrow();
  }
  expect(() => parseProviderSpendBudget({ ...account(), currency: 'usd' })).toThrow();
  expect(() => parseProviderSpendBudget({ ...account(), revision: 0 })).toThrow();
  expect(() => parseProviderSpendReservationDescriptor({ ...reservation(), budgetRevision: 0 })).toThrow();
  expect(() => parseProviderSpendQuote({ ...quote(), pricing: { ...quote().pricing, version: 0 } })).toThrow();
  expect(() => parseProviderSpendQuote({ ...quote(), extra: true })).toThrow();
});

it('requires reservation scope and currency to match its trusted-native quote', () => {
  expect(() => parseProviderSpendReservationDescriptor({ ...reservation(), scopeId: 'other' })).toThrow('PROVIDER_SPEND_SCOPE_MISMATCH');
  expect(() => parseProviderSpendReservationDescriptor({ ...reservation(), currency: 'EUR' })).toThrow('PROVIDER_SPEND_CURRENCY_MISMATCH');
  expect(() => parseProviderSpendReservationDescriptor({ ...reservation(), quote: { ...quote(), requestDigest: 'not-a-digest' } })).toThrow();
});
