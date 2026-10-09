import { parseOpenAiChatTextRequest, openAiChatWireObjectSchema, type OpenAiChatTextRequest } from '#adapters/core/provider-openai-chat/index.js';
import { sumCeilUsdCents, decimalText, multiplyRate, maxRate } from './decimal.js';
import { OpenRouterPricingError } from './error.js';
import { requireTariffRates, type OpenRouterTariff } from './tariff.js';
import { openRouterRequestControls } from './request-controls.js';

/** Same tool/message/stream contract as the shared transport; legacy max_tokens spelling remains supported. */
export function parseOpenRouterTextRequest(input: unknown): Omit<OpenAiChatTextRequest, 'max_completion_tokens'> & { readonly max_tokens?: number; readonly max_completion_tokens?: number } {
  const copied = openAiChatWireObjectSchema.safeParse(input);
  if (!copied.success) throw new OpenRouterPricingError('INVALID_REQUEST');
  const value = copied.data as Record<string, unknown>;
  if ((value['max_tokens'] === undefined) === (value['max_completion_tokens'] === undefined)) throw new OpenRouterPricingError('INVALID_REQUEST');
  const { max_tokens: maxTokens, ...rest } = value;
  try {
    const parsed = parseOpenAiChatTextRequest({ ...rest, max_completion_tokens: maxTokens ?? value['max_completion_tokens'] },
      { maxOutputTokens: Number.MAX_SAFE_INTEGER });
    const { max_completion_tokens: completion, ...request } = parsed;
    return Object.freeze({ ...request, ...(maxTokens === undefined ? { max_completion_tokens: completion } : { max_tokens: completion }) });
  } catch { throw new OpenRouterPricingError('INVALID_REQUEST'); }
}
export interface OpenRouterTextReservation {
  readonly schemaVersion: 2; readonly currency: 'USD'; readonly maxChargeMinorUnits: number;
  readonly metadataDigest: string; readonly tariffDigest: string; readonly maxPromptTokens: number; readonly maxCompletionTokens: number;
  readonly requestControls: typeof openRouterRequestControls;
  readonly provider: Readonly<{ only: readonly string[]; allow_fallbacks: false; require_parameters: true;
    max_price: Readonly<{ prompt: string; completion: string; request: string }> }>;
}

/** Conservative local reservation for one native text completion. This is not an external invoice guarantee.
 * Input uses the published endpoint bound, never a bytes/token guess. Cache/reasoning prices are added to
 * base prices, so replacement pricing cannot under-reserve. Each dimension covers all captured endpoints and conditional prices.
 */
export function quoteOpenRouterText(tariff: OpenRouterTariff, input: unknown, nowMs: number): OpenRouterTextReservation {
  const rates = requireTariffRates(tariff, nowMs), request = parseOpenRouterTextRequest(input);
  // Explicitly unpriced reachable SKUs cannot be bounded by a routing price filter.
  if (tariff.unpricedDimensions.length !== 0) throw new OpenRouterPricingError('INCOMPLETE_PRICING');
  if (request.model !== tariff.selection.modelId || request.model.endsWith(':online')) {
    throw new OpenRouterPricingError('INVALID_REQUEST');
  }
  const maxCompletionTokens = request.max_tokens ?? request.max_completion_tokens!;
  const parameter = request.max_tokens === undefined ? 'max_completion_tokens' : 'max_tokens';
  if (maxCompletionTokens > tariff.maxCompletionTokens || !tariff.supportedParameters.includes(parameter)) {
    throw new OpenRouterPricingError('INVALID_REQUEST');
  }
  if (request.tools && !tariff.supportedParameters.includes('tools')
    || request.tool_choice && !tariff.supportedParameters.includes('tool_choice')) throw new OpenRouterPricingError('INVALID_REQUEST');
  const dimensions = [multiplyRate(maxRate(rates.prompt, rates.input_cache_read), tariff.maxPromptTokens),
    multiplyRate(maxRate(rates.input_cache_write, rates.input_cache_write_1h), tariff.maxPromptTokens),
    multiplyRate(rates.completion, maxCompletionTokens), multiplyRate(rates.internal_reasoning, maxCompletionTokens), rates.request];
  return Object.freeze({ schemaVersion: 2, currency: 'USD', maxChargeMinorUnits: sumCeilUsdCents(dimensions),
    metadataDigest: tariff.metadataDigest, tariffDigest: tariff.tariffDigest, maxPromptTokens: tariff.maxPromptTokens, maxCompletionTokens,
    requestControls: openRouterRequestControls,
    provider: Object.freeze({ only: Object.freeze([tariff.selection.endpointTag]), allow_fallbacks: false, require_parameters: true,
      // Metadata is USD/token; routing max_price is USD/million tokens (request remains USD/request).
      max_price: Object.freeze({ prompt: decimalText(multiplyRate(rates.prompt, 1_000_000)),
        completion: decimalText(multiplyRate(rates.completion, 1_000_000)), request: decimalText(rates.request) }) }) });
}
