import { createHash } from 'node:crypto';
import { z } from 'zod';
import { counterSchema, immutableJsonObjectSchema, providerSpendBudgetSchema, providerSpendReservationDescriptorSchema,
  parseProviderSpendBudget, parseProviderSpendQuote, parseProviderSpendReservationDescriptor, type ProviderSpendBudget } from '#domain/index.js';
import { addProviderSpendExactMinorUnits, canonicalProviderSpendExactMinorUnits, ceilProviderSpendExactMinorUnits } from './exact.js';
import { ProviderSpendError } from './error.js';
import { parseProviderSpendReportedMeasurement, type ProviderSpendReportedMeasurement } from './reported.js';

const amount = counterSchema, digest = z.string().regex(/^[a-f0-9]{64}$/);
const holdReason = z.enum(['unknown', 'missing-usage', 'invalid-usage', 'price-unavailable', 'overrun']);
const accountSchema = z.object({ schemaVersion: z.literal(2), budget: providerSpendBudgetSchema,
  reservedMinorUnits: amount, settledMinorUnits: amount, settledExactMinorUnits: z.string(), frozen: z.boolean() }).strict().readonly();
const settlementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-sent'), evidenceDigest: digest }).strict(),
  z.object({ kind: z.literal('measured-local'), amountMinorUnits: amount, evidenceDigest: digest }).strict(),
  z.object({ kind: z.literal('provider-reported'), measurement: z.unknown(), evidenceDigest: digest }).strict(),
  z.object({ kind: z.literal('hold'), reason: holdReason.exclude(['overrun']), evidenceDigest: digest }).strict(),
]).readonly();
const dispositionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('reserved') }).strict(),
  z.object({ state: z.literal('released-not-sent'), evidenceDigest: digest }).strict(),
  z.object({ state: z.literal('settled-local'), amountMinorUnits: amount, evidenceDigest: digest }).strict(),
  z.object({ state: z.literal('settled-provider-reported'), amountMinorUnits: amount, evidenceDigest: digest }).strict(),
  z.object({ state: z.literal('held'), reason: holdReason, observedMinorUnits: amount.nullable(), evidenceDigest: digest }).strict(),
]).readonly();
const reservationSchema = z.object({ schemaVersion: z.literal(2), descriptor: providerSpendReservationDescriptorSchema,
  disposition: dispositionSchema, measurement: z.unknown().nullable() }).strict().readonly();
export type ProviderSpendAccount = z.infer<typeof accountSchema>;
export type ProviderSpendReservation = Omit<z.infer<typeof reservationSchema>, 'measurement'> & {
  readonly measurement: ProviderSpendReportedMeasurement | null;
};
export type ProviderSpendSettlement = z.infer<typeof settlementSchema> & { readonly measurement?: ProviderSpendReportedMeasurement };

export function providerSpendEvidenceDigest(input: unknown): string {
  const parsed = immutableJsonObjectSchema.safeParse(input);
  if (!parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
}
export function providerSpendQuoteDigest(input: unknown): string {
  const quote = parseProviderSpendQuote(input);
  if (providerSpendEvidenceDigest(quote.pricing.definition) !== quote.pricing.digest
    || providerSpendEvidenceDigest(quote.meter.evidence) !== quote.meter.evidenceDigest) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return createHash('sha256').update(`deckent.provider-spend-quote.v1\n${JSON.stringify(quote)}`).digest('hex');
}
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const copied = immutableJsonObjectSchema.safeParse(input), parsed = copied.success && schema.safeParse(copied.data);
  if (!parsed || !parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return parsed.data;
}
export function parseProviderSpendAccount(input: unknown): ProviderSpendAccount {
  const value = parse(accountSchema, input), exact = canonicalProviderSpendExactMinorUnits(value.settledExactMinorUnits);
  if (ceilProviderSpendExactMinorUnits(exact) !== value.settledMinorUnits
    || BigInt(value.reservedMinorUnits) + BigInt(value.settledMinorUnits) > BigInt(value.budget.limitMinorUnits)) {
    throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  }
  return Object.freeze(value);
}
function measurementMatches(value: ProviderSpendReservation, measurement: ProviderSpendReportedMeasurement): boolean {
  const d = value.descriptor;
  return measurement.quoteDigest === d.quoteDigest && measurement.requestDigest === d.quote.requestDigest
    && measurement.profileDigest === d.quote.profileDigest && measurement.currency === d.currency
    && measurement.source.tariffDigest === d.quote.pricing.digest;
}
export function parseProviderSpendReservation(input: unknown): ProviderSpendReservation {
  const raw = parse(reservationSchema, input), measurement = raw.measurement === null ? null : parseProviderSpendReportedMeasurement(raw.measurement);
  const value = { ...raw, measurement } as ProviderSpendReservation, cap = value.descriptor.quote.maxChargeMinorUnits, state = value.disposition;
  if (providerSpendQuoteDigest(value.descriptor.quote) !== value.descriptor.quoteDigest
    || (state.state === 'settled-provider-reported' && (measurement === null || !measurementMatches(value, measurement)))
    || (state.state === 'held' && state.reason === 'overrun' && measurement !== null && !measurementMatches(value, measurement))
    || (state.state !== 'settled-provider-reported' && !(state.state === 'held' && state.reason === 'overrun') && measurement !== null)
    || (state.state === 'settled-provider-reported'
      && (state.amountMinorUnits !== measurement?.roundedMinorUnits || state.amountMinorUnits > cap))
    || (state.state === 'settled-local' && state.amountMinorUnits > cap)
    || (state.state === 'held' && (state.reason === 'overrun'
      ? state.observedMinorUnits === null || state.observedMinorUnits <= cap
        || (measurement !== null && state.observedMinorUnits !== measurement.roundedMinorUnits)
      : state.observedMinorUnits !== null))) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return Object.freeze(value);
}
export function createProviderSpendAccount(input: unknown): ProviderSpendAccount {
  return parseProviderSpendAccount({ schemaVersion: 2, budget: parseProviderSpendBudget(input), reservedMinorUnits: 0,
    settledMinorUnits: 0, settledExactMinorUnits: '0', frozen: false });
}
function matches(budget: ProviderSpendBudget, descriptor: ProviderSpendReservation['descriptor']): void {
  if (budget.scopeId !== descriptor.scopeId || budget.budgetId !== descriptor.budgetId
    || budget.revision !== descriptor.budgetRevision || budget.currency !== descriptor.currency) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
}
export function reserveProviderSpend(accountInput: unknown, configuredBudgetInput: unknown, descriptorInput: unknown) {
  const account = parseProviderSpendAccount(accountInput), configured = parseProviderSpendBudget(configuredBudgetInput);
  const descriptor = parseProviderSpendReservationDescriptor(descriptorInput);
  if (providerSpendQuoteDigest(descriptor.quote) !== descriptor.quoteDigest) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  if (JSON.stringify(account.budget) !== JSON.stringify(configured)) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  matches(account.budget, descriptor);
  if (account.frozen) throw new ProviderSpendError('PROVIDER_SPEND_FROZEN');
  const reserved = BigInt(account.reservedMinorUnits) + BigInt(descriptor.quote.maxChargeMinorUnits);
  if (reserved + BigInt(account.settledMinorUnits) > BigInt(account.budget.limitMinorUnits)) throw new ProviderSpendError('PROVIDER_SPEND_EXHAUSTED');
  return Object.freeze({ account: parseProviderSpendAccount({ ...account, reservedMinorUnits: Number(reserved) }),
    reservation: parseProviderSpendReservation({ schemaVersion: 2, descriptor, disposition: { state: 'reserved' }, measurement: null }) });
}
export function settleProviderSpend(accountInput: unknown, reservationInput: unknown, settlementInput: unknown) {
  const account = parseProviderSpendAccount(accountInput), reservation = parseProviderSpendReservation(reservationInput);
  const settlement = parse(settlementSchema, settlementInput), descriptor = reservation.descriptor, maximum = descriptor.quote.maxChargeMinorUnits;
  matches(account.budget, descriptor);
  if (reservation.disposition.state !== 'reserved' || account.reservedMinorUnits < maximum) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  const measurement = settlement.kind === 'provider-reported' ? parseProviderSpendReportedMeasurement(settlement.measurement) : null;
  if (measurement && !measurementMatches(reservation, measurement)) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  const observed = settlement.kind === 'measured-local' ? settlement.amountMinorUnits : measurement?.roundedMinorUnits;
  const overrun = observed !== undefined && observed > maximum;
  if (overrun || settlement.kind === 'hold') {
    return Object.freeze({ account: parseProviderSpendAccount({ ...account, frozen: account.frozen || overrun }),
      reservation: parseProviderSpendReservation({ ...reservation, disposition: { state: 'held',
        reason: settlement.kind === 'hold' ? settlement.reason : 'overrun', observedMinorUnits: overrun ? observed : null,
        evidenceDigest: settlement.evidenceDigest }, measurement: overrun ? measurement : null }) });
  }
  const added = settlement.kind === 'measured-local' ? String(settlement.amountMinorUnits) : measurement?.exactMinorUnits ?? '0';
  const exact = addProviderSpendExactMinorUnits(account.settledExactMinorUnits, added);
  return Object.freeze({ account: parseProviderSpendAccount({ ...account, reservedMinorUnits: account.reservedMinorUnits - maximum,
    settledExactMinorUnits: exact, settledMinorUnits: ceilProviderSpendExactMinorUnits(exact) }),
    reservation: parseProviderSpendReservation({ ...reservation, measurement, disposition: settlement.kind === 'not-sent'
      ? { state: 'released-not-sent', evidenceDigest: settlement.evidenceDigest }
      : settlement.kind === 'measured-local' ? { state: 'settled-local', amountMinorUnits: settlement.amountMinorUnits, evidenceDigest: settlement.evidenceDigest }
      : { state: 'settled-provider-reported', amountMinorUnits: measurement!.roundedMinorUnits, evidenceDigest: settlement.evidenceDigest } }) });
}
