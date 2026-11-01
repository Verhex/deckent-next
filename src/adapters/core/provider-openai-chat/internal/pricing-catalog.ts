import { persistedInteger, persistedUrl, catalogTariffSealSchema } from '#domain/index.js';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import COMPATIBILITY from './request-compatibility.json' with { type: 'json' };
import data from './pricing.json' with { type: 'json' };

/** A vendor identity is registry data (request-compatibility.json `vendors`), so a new OpenAI-compatible maker is a data update. */
const vendorSchema = z.string().refine(value => (COMPATIBILITY.vendors as readonly string[]).includes(value));
const rate = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,4})?$/);
const rates = z.strictObject({ input: rate, cachedInput: rate, output: rate });
const cacheRates = rates.extend({ cacheWrite: rate }).strict();
const common = { kind: z.literal('vendor-published'), currency: z.literal('USD'), modelId: z.string().min(1).max(256), endpoint: persistedUrl(),
  // M4: `catalog` seals the registered catalog row `models connect` took a model's tariff from (absent on the shipped rows below).
  source: z.strictObject({ url: persistedUrl().startsWith('https://'), retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    catalog: catalogTariffSealSchema.optional() }) };
export const openAiCompatiblePublishedTariffSchema = z.discriminatedUnion('version', [
  z.strictObject({ ...common, version: z.literal(1), vendor: vendorSchema, usdPerMTok: rates,
    offPeakUsdPerMTok: rates.optional(), schedule: z.literal('provider-tier-required').optional() }),
  z.strictObject({ ...common, version: z.literal(2), vendor: z.literal('openai'), usdPerMTok: cacheRates,
    longContextAboveInputTokens: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    processingTiers: z.array(z.strictObject({ serviceTier: z.union([z.literal('default'), z.literal('flex'), z.literal('priority')]), usdPerMTok: cacheRates,
      longContextUsdPerMTok: cacheRates })).min(1).max(3)
      .refine(rows => new Set(rows.map(row => row.serviceTier)).size === rows.length && rows.some(row => row.serviceTier === 'default')),
  }),
]);
export type OpenAiCompatiblePublishedTariff = z.infer<typeof openAiCompatiblePublishedTariffSchema>;
const catalog = z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]), rows: z.array(openAiCompatiblePublishedTariffSchema) }).parse(data);
/** Exact model and endpoint lookup for invocation-profile producers; never an alias or a host suffix match. */
export function lookupOpenAiCompatibleTariff(endpoint: string, modelId: string): OpenAiCompatiblePublishedTariff | null {
  const row = catalog.rows.find(value => value.endpoint === endpoint && value.modelId === modelId);
  return row ? openAiCompatiblePublishedTariffSchema.parse(structuredClone(row)) : null;
}
/**
 * A shipped row is the authority for its exact endpoint and model: the profile's tariff must equal it. Without one (M4), only a tariff
 * `models connect` sealed from a registered catalog row, for exactly this endpoint and model, AND re-verified against that row by the spend
 * authority (`catalogVerified`, see `catalogTariffMatches`) is admitted; an unsealed or unverified one stays unverified.
 */
export function verifiedOpenAiCompatibleTariff(input: OpenAiCompatiblePublishedTariff, endpoint: string, modelId: string, catalogVerified = false): boolean {
  const shipped = lookupOpenAiCompatibleTariff(endpoint, modelId);
  if (shipped) return isDeepStrictEqual(input, shipped);
  return catalogVerified && input.source.catalog !== undefined && input.endpoint === endpoint && input.modelId === modelId;
}
/**
 * Security review M4: a sealed tariff equals the registered row's own term (`lookup` result, parsed by the adapter's tariff schema) under the
 * same seal. The lookup itself guarantees the (channel, model, revision) of the seal; a missing row, another revision or other numbers fail.
 */
export function catalogTariffMatches(tariff: Readonly<{ source: Readonly<{ catalog?: unknown }> }>, term: unknown,
  schema: z.ZodType<Readonly<{ source: object }>, unknown>): boolean {
  if (tariff.source.catalog === undefined || term === null || term === undefined) return false;
  const parsed = schema.safeParse(structuredClone(term));
  return parsed.success && isDeepStrictEqual({ ...parsed.data, source: { ...parsed.data.source, catalog: tariff.source.catalog } }, tariff);
}
