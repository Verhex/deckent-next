import { z } from 'zod';
import { immutableJsonObjectSchema } from '#domain/index.js';
import { sumCeilUsdCents, decimalText, multiplyRate } from './decimal.js';
import { OpenRouterPricingError } from './error.js';
import { requireTariffRates, type OpenRouterTariff } from './tariff.js';

const requestSchema = immutableJsonObjectSchema.pipe(z.object({ model: z.string().min(1),
  messages: z.array(z.object({ role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.string().min(1) }).strict()).min(1), max_tokens: z.number().int().positive().safe().optional(),
  max_completion_tokens: z.number().int().positive().safe().optional(),
  stream: z.literal(false).optional(), n: z.literal(1).optional() }).strict()
  .refine(value => (value.max_tokens === undefined) !== (value.max_completion_tokens === undefined)));
export function parseOpenRouterTextRequest(input: unknown) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new OpenRouterPricingError('INVALID_REQUEST');
  return Object.freeze({ ...parsed.data, messages: Object.freeze(parsed.data.messages.map(message => Object.freeze({ ...message }))) });
}
export interface OpenRouterTextReservation {
  readonly schemaVersion: 1; readonly currency: 'USD'; readonly maxChargeMinorUnits: number;
  readonly metadataDigest: string; readonly tariffDigest: string; readonly maxPromptTokens: number; readonly maxCompletionTokens: number;
  readonly provider: Readonly<{ only: readonly string[]; allow_fallbacks: false; require_parameters: true;
    max_price: Readonly<{ prompt: string; completion: string; request: string }> }>;
}

/** Conservative local reservation for one native text completion. This is not an external invoice guarantee.
 * Input uses the published endpoint bound, never a bytes/token guess. Cache/reasoning prices are added to
 * base prices, so replacement pricing cannot under-reserve. Conditional tariffs are explicitly unsupported.
 */
export function quoteOpenRouterText(tariff: OpenRouterTariff, input: unknown, nowMs: number): OpenRouterTextReservation {
  const rates = requireTariffRates(tariff, nowMs), request = requestSchema.safeParse(input);
  // A routing price filter is not evidence for an absent tariff rate, including per-request charges.
  // Missing dimensions require a proven native inclusion/reachability rule before enabling this path.
  if (tariff.unpricedDimensions.length !== 0) throw new OpenRouterPricingError('INCOMPLETE_PRICING');
  if (!request.success || request.data.model !== tariff.selection.modelId) {
    throw new OpenRouterPricingError('INVALID_REQUEST');
  }
  const maxCompletionTokens = request.data.max_tokens ?? request.data.max_completion_tokens!;
  const parameter = request.data.max_tokens === undefined ? 'max_completion_tokens' : 'max_tokens';
  if (maxCompletionTokens > tariff.maxCompletionTokens || !tariff.supportedParameters.includes(parameter)) {
    throw new OpenRouterPricingError('INVALID_REQUEST');
  }
  const dimensions = [multiplyRate(rates.prompt, tariff.maxPromptTokens),
    multiplyRate(rates.input_cache_read, tariff.maxPromptTokens), multiplyRate(rates.input_cache_write, tariff.maxPromptTokens),
    multiplyRate(rates.completion, maxCompletionTokens), multiplyRate(rates.internal_reasoning, maxCompletionTokens), rates.request];
  return Object.freeze({ schemaVersion: 1, currency: 'USD', maxChargeMinorUnits: sumCeilUsdCents(dimensions),
    metadataDigest: tariff.metadataDigest, tariffDigest: tariff.tariffDigest, maxPromptTokens: tariff.maxPromptTokens, maxCompletionTokens,
    provider: Object.freeze({ only: Object.freeze([tariff.selection.endpointTag]), allow_fallbacks: false, require_parameters: true,
      // Metadata is USD/token; routing max_price is USD/million tokens (request remains USD/request).
      max_price: Object.freeze({ prompt: decimalText(multiplyRate(rates.prompt, 1_000_000)),
        completion: decimalText(multiplyRate(rates.completion, 1_000_000)), request: decimalText(rates.request) }) }) });
}
