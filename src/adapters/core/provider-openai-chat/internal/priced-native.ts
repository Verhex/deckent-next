import { isDeepStrictEqual } from 'node:util';
import type { ModelInvocationNativeResponse, ProviderSpendQuote } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationResponseContentDescriptor, providerSpendQuoteDigest, parseProviderSpendTariffMeasurement,
  measuredTariffExactMinorUnits, ceilProviderSpendExactMinorUnits, type ModelInvocationSpendingInput, type ModelInvocationNativePort } from '#engine/index.js';
import { createOpenAiChatNativePort, type OpenAiChatNativePortOptions, type PreparedOpenAiChatRequest } from './transport.js';
import { OpenAiChatHttpError, openAiChatUsageSchema, parseOpenAiChatTextRequest } from './contract.js';
import { quoteOpenAiChatOperatorTariff, openAiCompatibleTariffRates } from './tariff.js';
export function createOpenAiChatPricedNative(options: OpenAiChatNativePortOptions = {}) {
  const responses = new WeakMap<object, string>();
  const partialUsage = new WeakMap<object, { usage: unknown; serviceTier: unknown }>();
  // Filled only by the final-usage callback (Astra 2459/2462 R1): partial settlement never reads an interim count or tier.
  // A contradiction after it withdraws the entry, so a bounded refusal holds the reservation instead of settling (Astra 2467).
  const delegate = createOpenAiChatNativePort({ ...options, onFinalUsage: (prepared, usage, serviceTier) => { partialUsage.set(prepared, { usage, serviceTier }); },
    onFinalUsageWithdrawn: prepared => { partialUsage.delete(prepared); } }), quotes = new WeakMap<object, ProviderSpendQuote>();
  const profiles = new WeakMap<object, string>();
  const measure = (token: unknown, usageInput: unknown, contentDigest: string, serviceTier?: unknown) => {
      const quote = quotes.get(token as object), prepared = token as PreparedOpenAiChatRequest;
      if (!quote || usageInput === null) return null;
      const usage = openAiChatUsageSchema.safeParse(usageInput);
      if (!usage.success) return null;
      const tariff = prepared.definition.tariff;
      // Owner S4: unknown DeepSeek billing tier uses peak and an explicit upper-bound label.
      const upperBound = tariff.kind === 'vendor-published' && tariff.version === 1 && tariff.vendor === 'deepseek' && tariff.schedule !== undefined;
      let rates = openAiCompatibleTariffRates(tariff, prepared.definition.endpoint, prepared.request.model);
      const details = usage.data['prompt_tokens_details'] as Record<string, unknown> | undefined;
      if (details !== undefined && (details === null || typeof details !== 'object' || Array.isArray(details))) return null;
      const cached = details?.['cached_tokens'] ?? usage.data['prompt_cache_hit_tokens'] ?? 0;
      if (details?.['cached_tokens'] !== undefined && usage.data['prompt_cache_hit_tokens'] !== undefined && details['cached_tokens'] !== usage.data['prompt_cache_hit_tokens']) return null;
      if (typeof cached !== 'number' || !Number.isSafeInteger(cached) || cached < 0 || cached > usage.data.prompt_tokens) return null;
      let written = 0, tier: number | 'upper-bound' | null = upperBound ? 'upper-bound' : null;
      const tiered = tariff.kind === 'vendor-published' && tariff.version === 2;
      if (tiered) {
        // An absent or null count is unknown, not a cache count of zero: the raw reported fields decide (Astra 2467 P2).
        const count = details?.['cache_write_tokens'];
        if (typeof details?.['cached_tokens'] !== 'number' || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > usage.data.prompt_tokens - cached) return null;
        written = count;
        const published = tariff.processingTiers.find(row => row.serviceTier === (serviceTier === 'fast' ? 'priority' : serviceTier));
        if (!published) return null;
        tier = usage.data.prompt_tokens > tariff.longContextAboveInputTokens ? 1 : 0;
        rates = tier === 1 ? published.longContextUsdPerMTok : published.usdPerMTok;
      }
      const dimensions = [
        { field: 'input', tokens: usage.data.prompt_tokens - cached - written, usdPerMillionTokens: rates.input },
        { field: 'cached-input', tokens: cached, usdPerMillionTokens: rates.cachedInput },
        ...(tiered ? [{ field: 'cache-write', tokens: written, usdPerMillionTokens: 'cacheWrite' in rates ? rates.cacheWrite! : rates.input }] : []),
        // Responses reasoning tokens are INCLUDED in output_tokens, at the output tariff. Split for audit, never add twice.
        ...(prepared.definition.dialect?.protocol === 'responses' ? (() => {
          const details = usage.data['completion_tokens_details'] as { reasoning_tokens: number };
          return [{ field: 'output', tokens: usage.data.completion_tokens - details.reasoning_tokens, usdPerMillionTokens: rates.output },
            { field: 'reasoning', tokens: details.reasoning_tokens, usdPerMillionTokens: rates.output }];
        })() : [{ field: 'output', tokens: usage.data.completion_tokens, usdPerMillionTokens: rates.output }]),
      ];
      const exactMinorUnits = measuredTariffExactMinorUnits(dimensions);
      return parseProviderSpendTariffMeasurement({ schemaVersion: 1, basis: 'measured-tariff', currency: quote.currency,
        exactMinorUnits, roundedMinorUnits: ceilProviderSpendExactMinorUnits(exactMinorUnits), quoteDigest: providerSpendQuoteDigest(quote),
        requestDigest: quote.requestDigest, profileDigest: quote.profileDigest, responseContentDigest: contentDigest,
        source: { id: 'openai-compatible-usage-tariff', version: 1, modelId: prepared.request.model, tariffDigest: quote.pricing.digest,
          tier, ...(tiered ? { serviceTier: serviceTier === 'fast' ? 'priority' : serviceTier } : {}), cacheSplit: tiered ? 'reported' : 'none', dimensions } });
  };
  const native: ModelInvocationNativePort = {
    ...delegate,
    async prepare(profile, binding, request) {
      const prepared = await delegate.prepare(profile, binding, request);
      profiles.set(prepared as object, modelInvocationProfileDigest(profile)); return prepared;
    },
    async send(token, signal, onDelta) {
      const result = await delegate.send(token, signal, onDelta);
      if (!('kind' in result)) responses.set(token as object, modelInvocationResponseContentDescriptor(result).digest);
      return result;
    },
    observePartialSpending(token: unknown, contentDigest: string) {
      const usage = partialUsage.get(token as object);
      return usage ? measure(token, usage.usage, contentDigest, usage.serviceTier) : null;
    },
    observeSpending(token: unknown, response: ModelInvocationNativeResponse) {
      const digest = modelInvocationResponseContentDescriptor(response).digest;
      return responses.get(token as object) === digest ? measure(token, response.usage, digest, response.native['service_tier']) : null;
    },
  };
  return Object.freeze({ native: Object.freeze(native), quote(input: ModelInvocationSpendingInput) {
    const prepared = input.prepared as PreparedOpenAiChatRequest;
    if (!prepared || typeof prepared !== 'object' || profiles.get(prepared) !== input.profileDigest
      || !isDeepStrictEqual(prepared.request, parseOpenAiChatTextRequest(input.command.nativeRequest, prepared.definition))) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
    const quote = quoteOpenAiChatOperatorTariff(input, prepared.body, prepared.reasoningInputTokensUpperBound); quotes.set(prepared, quote); return quote;
  } });
}
