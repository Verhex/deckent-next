import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import data from './pricing.json' with { type: 'json' };
const rate = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,4})?$/);
const rates = z.object({ input: rate, cachedInput: rate, output: rate }).strict();
const cacheRates = rates.extend({ cacheWrite: rate }).strict();
const common = { kind: z.literal('vendor-published'), currency: z.literal('USD'), modelId: z.string().min(1).max(256), endpoint: z.string().url(),
  source: z.object({ url: z.string().url().startsWith('https://'), retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict() };
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
export function verifiedOpenAiCompatibleTariff(input: OpenAiCompatiblePublishedTariff, endpoint: string, modelId: string): boolean {
  return isDeepStrictEqual(input, lookupOpenAiCompatibleTariff(endpoint, modelId));
}
