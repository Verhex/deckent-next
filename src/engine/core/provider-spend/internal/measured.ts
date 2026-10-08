import { z } from 'zod';
import { counterSchema, identitySchema, immutableJsonObjectSchema } from '#domain/index.js';
import { ProviderSpendError } from './error.js';
import { canonicalProviderSpendExactMinorUnits, ceilProviderSpendExactMinorUnits, providerSpendExactFromNumericSource } from './exact.js';
import { parseProviderSpendReportedMeasurement, type ProviderSpendReportedMeasurement } from './reported.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const rate = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,4})?$/);
const dimensionSchema = z.object({ field: identitySchema, tokens: counterSchema, usdPerMillionTokens: rate }).strict();
const dimensionsSchema = z.array(dimensionSchema).min(1).max(8).readonly();
const schema = z.object({ schemaVersion: z.literal(1), basis: z.literal('measured-tariff'),
  currency: z.string().regex(/^[A-Z]{3}$/), exactMinorUnits: z.string(), roundedMinorUnits: counterSchema,
  quoteDigest: digest, requestDigest: digest, profileDigest: digest, responseContentDigest: digest,
  source: z.object({ id: identitySchema, version: counterSchema.positive(), modelId: identitySchema, tariffDigest: digest,
    tier: counterSchema.or(z.literal('upper-bound')).nullable(), serviceTier: z.union([z.literal('default'), z.literal('flex'), z.literal('priority')]).optional(), cacheSplit: z.enum(['reported', 'dearest', 'none']),
    dimensions: dimensionsSchema,
  }).strict().readonly(),
}).strict().readonly();
export type ProviderSpendTariffMeasurement = z.infer<typeof schema>;
export type ProviderSpendMeasurement = ProviderSpendReportedMeasurement | ProviderSpendTariffMeasurement;
/** Integer rate units of 0.0001 USD/MTok; convert once to exact cents, without binary floating point. */
export function measuredTariffExactMinorUnits(dimensions: ProviderSpendTariffMeasurement['source']['dimensions']): string {
  const checked = dimensionsSchema.safeParse(dimensions);
  if (!checked.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  let numerator = 0n;
  for (const dimension of checked.data) {
    const [whole = '0', fraction = ''] = dimension.usdPerMillionTokens.split('.');
    numerator += BigInt(dimension.tokens) * (BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0')));
  }
  return providerSpendExactFromNumericSource(`${numerator}e-8`, 1);
}
export function parseProviderSpendTariffMeasurement(input: unknown): ProviderSpendTariffMeasurement {
  const copied = immutableJsonObjectSchema.safeParse(input), parsed = copied.success && schema.safeParse(copied.data);
  if (!parsed || !parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const value = parsed.data;
  if (new Set(value.source.dimensions.map(d => d.field)).size !== value.source.dimensions.length
    || measuredTariffExactMinorUnits(value.source.dimensions) !== canonicalProviderSpendExactMinorUnits(value.exactMinorUnits)
    || ceilProviderSpendExactMinorUnits(value.exactMinorUnits) !== value.roundedMinorUnits) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return value;
}
export function parseProviderSpendMeasurement(input: unknown): ProviderSpendMeasurement {
  return input && typeof input === 'object' && 'basis' in input && input.basis === 'measured-tariff'
    ? parseProviderSpendTariffMeasurement(input) : parseProviderSpendReportedMeasurement(input);
}
