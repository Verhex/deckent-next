import { z } from 'zod';
import { createHash } from 'node:crypto';
import { counterSchema, immutableJsonObjectSchema, providerSpendBudgetSchema, providerSpendReservationDescriptorSchema,
  parseProviderSpendBudget, parseProviderSpendQuote, parseProviderSpendReservationDescriptor, type ProviderSpendBudget } from '#domain/index.js';

export type ProviderSpendErrorCode = 'PROVIDER_SPEND_INVALID' | 'PROVIDER_SPEND_CONFLICT'
  | 'PROVIDER_SPEND_EXHAUSTED' | 'PROVIDER_SPEND_FROZEN' | 'PROVIDER_SPEND_UNAVAILABLE';
export class ProviderSpendError extends Error {
  constructor(readonly code: ProviderSpendErrorCode) { super(code); this.name = 'ProviderSpendError'; }
}
const amount = counterSchema;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const holdReason = z.enum(['unknown', 'missing-usage', 'invalid-usage', 'price-unavailable', 'overrun']);
const accountSchema = z.object({ schemaVersion: z.literal(1), budget: providerSpendBudgetSchema,
  reservedMinorUnits: amount, settledMinorUnits: amount, frozen: z.boolean() }).strict().readonly();
const settlementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-sent'), evidenceDigest: digest }).strict(),
  z.object({ kind: z.literal('measured-local'), amountMinorUnits: amount, evidenceDigest: digest }).strict(),
  z.object({ kind: z.literal('hold'), reason: holdReason.exclude(['overrun']), evidenceDigest: digest }).strict(),
]).readonly();
const dispositionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('reserved') }).strict(),
  z.object({ state: z.literal('released-not-sent'), evidenceDigest: digest }).strict(),
  z.object({ state: z.literal('settled-local'), amountMinorUnits: amount, evidenceDigest: digest }).strict(),
  z.object({ state: z.literal('held'), reason: holdReason, observedMinorUnits: amount.nullable(), evidenceDigest: digest }).strict(),
]).readonly();
const reservationSchema = z.object({ schemaVersion: z.literal(1), descriptor: providerSpendReservationDescriptorSchema,
  disposition: dispositionSchema }).strict().readonly();
export type ProviderSpendAccount = z.infer<typeof accountSchema>;
export type ProviderSpendReservation = z.infer<typeof reservationSchema>;
export type ProviderSpendSettlement = z.infer<typeof settlementSchema>;

/** Deterministic digest of descriptor-safe JSON. Integrity does not establish source authenticity. */
export function providerSpendEvidenceDigest(input: unknown): string {
  const parsed = immutableJsonObjectSchema.safeParse(input);
  if (!parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
}
export function providerSpendQuoteDigest(input: unknown): string {
  const quote = parseProviderSpendQuote(input);
  if (providerSpendEvidenceDigest(quote.pricing.definition) !== quote.pricing.digest
    || providerSpendEvidenceDigest(quote.meter.evidence) !== quote.meter.evidenceDigest) {
    throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  }
  return createHash('sha256').update(`deckent.provider-spend-quote.v1\n${JSON.stringify(quote)}`).digest('hex');
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const copied = immutableJsonObjectSchema.safeParse(input), parsed = copied.success && schema.safeParse(copied.data);
  if (!parsed || !parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return parsed.data;
}
export function parseProviderSpendAccount(input: unknown): ProviderSpendAccount {
  const value = parse(accountSchema, input);
  if (BigInt(value.reservedMinorUnits) + BigInt(value.settledMinorUnits) > BigInt(value.budget.limitMinorUnits)) {
    throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  }
  return value;
}
export function parseProviderSpendReservation(input: unknown): ProviderSpendReservation {
  const value = parse(reservationSchema, input), cap = value.descriptor.quote.maxChargeMinorUnits, disposition = value.disposition;
  if (providerSpendQuoteDigest(value.descriptor.quote) !== value.descriptor.quoteDigest
    || (disposition.state === 'settled-local' && disposition.amountMinorUnits > cap)
    || (disposition.state === 'held' && (disposition.reason === 'overrun'
      ? disposition.observedMinorUnits === null || disposition.observedMinorUnits <= cap : disposition.observedMinorUnits !== null))) {
    throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  }
  return value;
}
export function createProviderSpendAccount(input: unknown): ProviderSpendAccount {
  return parseProviderSpendAccount({ schemaVersion: 1, budget: parseProviderSpendBudget(input),
    reservedMinorUnits: 0, settledMinorUnits: 0, frozen: false });
}
function matches(budget: ProviderSpendBudget, descriptor: ProviderSpendReservation['descriptor']): void {
  if (budget.scopeId !== descriptor.scopeId || budget.budgetId !== descriptor.budgetId
    || budget.revision !== descriptor.budgetRevision || budget.currency !== descriptor.currency) {
    throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  }
}
/** Pure transaction plan. Its caller must atomically deduplicate the invocation and persist both records. */
export function reserveProviderSpend(accountInput: unknown, configuredBudgetInput: unknown, descriptorInput: unknown) {
  const account = parseProviderSpendAccount(accountInput), configured = parseProviderSpendBudget(configuredBudgetInput);
  const descriptor = parseProviderSpendReservationDescriptor(descriptorInput);
  if (providerSpendQuoteDigest(descriptor.quote) !== descriptor.quoteDigest) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  if (JSON.stringify(account.budget) !== JSON.stringify(configured)) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  matches(account.budget, descriptor);
  if (account.frozen) throw new ProviderSpendError('PROVIDER_SPEND_FROZEN');
  const reserved = BigInt(account.reservedMinorUnits) + BigInt(descriptor.quote.maxChargeMinorUnits);
  if (reserved + BigInt(account.settledMinorUnits) > BigInt(account.budget.limitMinorUnits)) {
    throw new ProviderSpendError('PROVIDER_SPEND_EXHAUSTED');
  }
  return Object.freeze({ account: parseProviderSpendAccount({ ...account, reservedMinorUnits: Number(reserved) }),
    reservation: parseProviderSpendReservation({ schemaVersion: 1, descriptor, disposition: { state: 'reserved' } }) });
}
/** Evidence is supplied by the trusted invocation owner, never by model output or a public settlement command. */
export function settleProviderSpend(accountInput: unknown, reservationInput: unknown, settlementInput: unknown) {
  const account = parseProviderSpendAccount(accountInput), reservation = parseProviderSpendReservation(reservationInput);
  const settlement = parse(settlementSchema, settlementInput), descriptor = reservation.descriptor, maximum = descriptor.quote.maxChargeMinorUnits;
  matches(account.budget, descriptor);
  if (reservation.disposition.state !== 'reserved' || account.reservedMinorUnits < maximum) {
    throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  }
  const overrun = settlement.kind === 'measured-local' && settlement.amountMinorUnits > maximum;
  if (overrun || settlement.kind === 'hold') {
    return Object.freeze({ account: parseProviderSpendAccount({ ...account, frozen: account.frozen || overrun }),
      reservation: parseProviderSpendReservation({ ...reservation, disposition: { state: 'held',
        reason: settlement.kind === 'hold' ? settlement.reason : 'overrun',
        observedMinorUnits: settlement.kind === 'measured-local' ? settlement.amountMinorUnits : null,
        evidenceDigest: settlement.evidenceDigest } }) });
  }
  const charged = settlement.kind === 'measured-local' ? settlement.amountMinorUnits : 0;
  return Object.freeze({ account: parseProviderSpendAccount({ ...account, reservedMinorUnits: account.reservedMinorUnits - maximum,
    settledMinorUnits: Number(BigInt(account.settledMinorUnits) + BigInt(charged)) }),
  reservation: parseProviderSpendReservation({ ...reservation, disposition: settlement.kind === 'not-sent'
    ? { state: 'released-not-sent', evidenceDigest: settlement.evidenceDigest }
    : { state: 'settled-local', amountMinorUnits: charged, evidenceDigest: settlement.evidenceDigest } }) });
}
