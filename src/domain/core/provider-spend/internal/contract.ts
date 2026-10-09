import { z } from 'zod';
import limits from './inspection-limits.json' with { type: 'json' };
import { counterSchema, identitySchema, immutableJsonObjectSchema } from '#domain/core/primitives/index.js';
export const PROVIDER_SPEND_HOLD_PAGE_MAX = limits.maxHoldsPerPage;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
// Adapter-owned data, never a credential or user prompt. The enclosing immutable JSON envelope
// bounds the complete quote, including both evidence documents; hashes alone cannot recover a tariff.
const versionedPricingSchema = z.object({ id: identitySchema, version: counterSchema.positive(), digest: digestSchema,
  definition: immutableJsonObjectSchema }).strict().readonly();

export const providerSpendBudgetSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  budgetId: identitySchema, revision: counterSchema.positive(), currency: currencySchema, limitMinorUnits: counterSchema }).strict().readonly();

/** Stage 1: the budget id a governed `budget-create` gets from the CLI and the terminal (one shared limit per scope across every API provider). */
export const PROVIDER_SPEND_SCOPE_BUDGET_ID = 'scope-budget' as const;
/** An exact account revision, or (stage 1) `current: true`: the scope's account whatever budget id and revision it holds — when none exists, the
 * result names `PROVIDER_SPEND_SCOPE_BUDGET_ID` revision 1 with no checkpoint (what a create would write). */
const holds = z.object({ afterInvocationId: identitySchema.nullable(), limit: counterSchema.positive().max(PROVIDER_SPEND_HOLD_PAGE_MAX) }).strict().readonly();
const queryVersion = z.union([z.literal(1), z.literal(2)]);
export const providerSpendExactAccountQuerySchema = z.object({ schemaVersion: queryVersion, scopeId: identitySchema,
  budgetId: identitySchema, budgetRevision: counterSchema.positive(), holds: holds.optional() }).strict()
  .refine(query => (query.schemaVersion === 2) === (query.holds !== undefined)).readonly();
export const providerSpendAccountQuerySchema = z.union([providerSpendExactAccountQuerySchema,
  z.object({ schemaVersion: queryVersion, scopeId: identitySchema, current: z.literal(true), holds: holds.optional() }).strict().readonly()])
  .refine(query => (query.schemaVersion === 2) === (query.holds !== undefined));

export const providerSpendQuoteSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  requestDigest: digestSchema, profileDigest: digestSchema, pricing: versionedPricingSchema,
  meter: z.object({ id: identitySchema, version: counterSchema.positive(), evidenceDigest: digestSchema,
    evidence: immutableJsonObjectSchema }).strict().readonly(),
  currency: currencySchema, maxChargeMinorUnits: counterSchema }).strict().readonly();

export const providerSpendReservationDescriptorSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  invocationId: identitySchema, budgetId: identitySchema, budgetRevision: counterSchema.positive(), currency: currencySchema,
  quoteDigest: digestSchema, quote: providerSpendQuoteSchema }).strict().superRefine((value, context) => {
  if (value.scopeId !== value.quote.scopeId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['quote', 'scopeId'], message: 'PROVIDER_SPEND_SCOPE_MISMATCH' });
  if (value.currency !== value.quote.currency) context.addIssue({ code: z.ZodIssueCode.custom, path: ['quote', 'currency'], message: 'PROVIDER_SPEND_CURRENCY_MISMATCH' });
}).readonly();

const budgetInputSchema = immutableJsonObjectSchema.pipe(providerSpendBudgetSchema);
export const providerSpendAccountQueryInputSchema = immutableJsonObjectSchema.pipe(providerSpendAccountQuerySchema);
const quoteInputSchema = immutableJsonObjectSchema.pipe(providerSpendQuoteSchema);
const reservationInputSchema = immutableJsonObjectSchema.pipe(providerSpendReservationDescriptorSchema);

export function parseProviderSpendBudget(input: unknown): ProviderSpendBudget { return budgetInputSchema.parse(input); }
export function parseProviderSpendAccountQuery(input: unknown): ProviderSpendAccountQuery { return providerSpendAccountQueryInputSchema.parse(input); }
export function parseProviderSpendQuote(input: unknown): ProviderSpendQuote { return quoteInputSchema.parse(input); }
export function parseProviderSpendReservationDescriptor(input: unknown): ProviderSpendReservationDescriptor {
  return reservationInputSchema.parse(input);
}

export type ProviderSpendBudget = z.infer<typeof providerSpendBudgetSchema>;
export type ProviderSpendAccountQuery = z.infer<typeof providerSpendAccountQuerySchema>;
export type ProviderSpendExactAccountQuery = Extract<ProviderSpendAccountQuery, { budgetId: string }>;
export type ProviderSpendQuote = z.infer<typeof providerSpendQuoteSchema>;
export type ProviderSpendReservationDescriptor = z.infer<typeof providerSpendReservationDescriptorSchema>;
