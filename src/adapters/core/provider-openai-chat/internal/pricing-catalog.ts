import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import data from './pricing.json' with { type: 'json' };
const rate = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,4})?$/);
const rates = z.object({ input: rate, cachedInput: rate, output: rate }).strict();
export const openAiCompatiblePublishedTariffSchema = z.object({ kind: z.literal('vendor-published'), version: z.literal(1),
  vendor: z.enum(['openai', 'deepseek', 'zai']), currency: z.literal('USD'), modelId: z.string().min(1).max(256), endpoint: z.string().url(),
  usdPerMTok: rates, offPeakUsdPerMTok: rates.optional(), schedule: z.literal('provider-tier-required').optional(),
  source: z.object({ url: z.string().url().startsWith('https://'), retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
}).strict();
export type OpenAiCompatiblePublishedTariff = z.infer<typeof openAiCompatiblePublishedTariffSchema>;
const catalog = z.object({ schemaVersion: z.literal(1), rows: z.array(openAiCompatiblePublishedTariffSchema) }).strict().parse(data);
/** Exact model and endpoint lookup for invocation-profile producers (T4-B); never an alias or a host suffix match. */
export function lookupOpenAiCompatibleTariff(endpoint: string, modelId: string): OpenAiCompatiblePublishedTariff | null {
  const row = catalog.rows.find(value => value.endpoint === endpoint && value.modelId === modelId);
  return row ? openAiCompatiblePublishedTariffSchema.parse(structuredClone(row)) : null;
}
export function verifiedOpenAiCompatibleTariff(input: OpenAiCompatiblePublishedTariff, endpoint: string, modelId: string): boolean {
  return isDeepStrictEqual(input, lookupOpenAiCompatibleTariff(endpoint, modelId));
}
