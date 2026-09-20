import { z } from 'zod';
import { counterSchema, identitySchema, immutableJsonObjectSchema } from '#domain/index.js';
import { ProviderSpendError } from './error.js';
import { canonicalProviderSpendExactMinorUnits, ceilProviderSpendExactMinorUnits,
  providerSpendExactFromNumericSource } from './exact.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bounded = z.string().min(1).max(1024).refine(value => value.trim() === value);
const measurementSchema = z.object({ schemaVersion: z.literal(1), basis: z.literal('provider-reported'),
  currency: z.string().regex(/^[A-Z]{3}$/), exactMinorUnits: z.string(), roundedMinorUnits: counterSchema,
  quoteDigest: digest, requestDigest: digest, profileDigest: digest, responseContentDigest: digest,
  source: z.object({ id: identitySchema, version: counterSchema.positive(), field: bounded, generationId: bounded,
    modelId: bounded, numericSource: z.string().min(1).max(1024), minorUnitsPerCurrencyUnit: counterSchema.positive(),
    bodyDigest: digest, responseDigest: digest, requestBodyDigest: digest, tariffDigest: digest,
    selectedEndpointTag: bounded }).strict().readonly(),
}).strict().readonly();
export type ProviderSpendReportedMeasurement = Readonly<z.infer<typeof measurementSchema>>;
export function parseProviderSpendReportedMeasurement(input: unknown): ProviderSpendReportedMeasurement {
  const copied = immutableJsonObjectSchema.safeParse(input), parsed = copied.success && measurementSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const value = parsed.data, exact = canonicalProviderSpendExactMinorUnits(value.exactMinorUnits);
  if (providerSpendExactFromNumericSource(value.source.numericSource, value.source.minorUnitsPerCurrencyUnit) !== exact
    || ceilProviderSpendExactMinorUnits(exact) !== value.roundedMinorUnits) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return value;
}
