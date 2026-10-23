import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import data from './pricing.json' with { type: 'json' };
import { catalogTariffSealSchema } from '#domain/index.js';
const rate = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,4})?$/);
const rates = z.object({ input: rate, cachedInput: rate, output: rate }).strict();
const cacheRates = rates.extend({ cacheWrite: rate }).strict();
const common = { kind: z.literal('vendor-published'), currency: z.literal('USD'), modelId: z.string().min(1).max(256), endpoint: z.string().url(),
  // M4: `catalog` seals the registered catalog row `models connect` took a model's tariff from (absent on the shipped rows below).
  source: z.object({ url: z.string().url().startsWith('https://'), retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    catalog: catalogTariffSealSchema.optional() }).strict() };
export const openAiCompatiblePublishedTariffSchema = z.discriminatedUnion('version', [
  z.object({ ...common, version: z.literal(1), vendor: z.enum(['openai', 'deepseek', 'zai']), usdPerMTok: rates,
    offPeakUsdPerMTok: rates.optional(), schedule: z.literal('provider-tier-required').optional() }).strict(),
  z.object({ ...common, version: z.literal(2), vendor: z.literal('openai'), usdPerMTok: cacheRates,
    longContextAboveInputTokens: z.number().int().positive().safe(),
    processingTiers: z.array(z.object({ serviceTier: z.union([z.literal('default'), z.literal('flex'), z.literal('priority')]), usdPerMTok: cacheRates,
      longContextUsdPerMTok: cacheRates }).strict()).min(1).max(3)
      .refine(rows => new Set(rows.map(row => row.serviceTier)).size === rows.length && rows.some(row => row.serviceTier === 'default')),
  }).strict(),
]);
export type OpenAiCompatiblePublishedTariff = z.infer<typeof openAiCompatiblePublishedTariffSchema>;
const catalog = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), rows: z.array(openAiCompatiblePublishedTariffSchema) }).strict().parse(data);
/** Exact model and endpoint lookup for invocation-profile producers; never an alias or a host suffix match. */
export function lookupOpenAiCompatibleTariff(endpoint: string, modelId: string): OpenAiCompatiblePublishedTariff | null {
  const row = catalog.rows.find(value => value.endpoint === endpoint && value.modelId === modelId);
  return row ? openAiCompatiblePublishedTariffSchema.parse(structuredClone(row)) : null;
}
/**
 * A shipped row is the authority for its exact endpoint and model: the profile's tariff must equal it. Without one (M4), only a tariff
 * `models connect` sealed from a registered catalog row for exactly this endpoint and model is admitted; an unsealed one stays unverified.
 */
export function verifiedOpenAiCompatibleTariff(input: OpenAiCompatiblePublishedTariff, endpoint: string, modelId: string): boolean {
  const shipped = lookupOpenAiCompatibleTariff(endpoint, modelId);
  if (shipped) return isDeepStrictEqual(input, shipped);
  return input.source.catalog !== undefined && input.endpoint === endpoint && input.modelId === modelId;
}
