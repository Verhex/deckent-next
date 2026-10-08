import { isDeepStrictEqual } from 'node:util';
import type { ModelInvocationNativeResponse, ProviderSpendQuote } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationResponseContentDescriptor, providerSpendQuoteDigest, parseProviderSpendTariffMeasurement,
  measuredTariffExactMinorUnits, ceilProviderSpendExactMinorUnits, type ModelInvocationSpendingInput, type ModelInvocationNativePort } from '#engine/index.js';
import { createOpenAiChatNativePort, type OpenAiChatNativePortOptions, type PreparedOpenAiChatRequest } from './transport.js';
import { OpenAiChatHttpError, openAiChatUsageSchema, parseOpenAiChatTextRequest } from './contract.js';
import { quoteOpenAiChatOperatorTariff, openAiCompatibleTariffRates } from './tariff.js';
export function createOpenAiChatPricedNative(options: OpenAiChatNativePortOptions = {}) {
  const responses = new WeakMap<object, string>();
  const partialUsage = new WeakMap<object, unknown>();
  const delegate = createOpenAiChatNativePort({ ...options, onUsage: (prepared, usage) => { partialUsage.set(prepared, usage); } }), quotes = new WeakMap<object, ProviderSpendQuote>();
  const profiles = new WeakMap<object, string>();
  const measure = (token: unknown, usageInput: unknown, contentDigest: string) => {
      const quote = quotes.get(token as object), prepared = token as PreparedOpenAiChatRequest;
      if (!quote || usageInput === null) return null;
      const usage = openAiChatUsageSchema.safeParse(usageInput);
      if (!usage.success) return null;
      const tariff = prepared.definition.tariff;
      // Peak/off-peak tariffs require a trustworthy provider tier; no guessed holiday calendar or silent peak overcharge.
      if (tariff.kind === 'vendor-published' && tariff.schedule) return null;
      const rates = openAiCompatibleTariffRates(tariff, prepared.definition.endpoint, prepared.request.model);
      const details = usage.data['prompt_tokens_details'] as Record<string, unknown> | undefined;
      if (details !== undefined && (details === null || typeof details !== 'object' || Array.isArray(details))) return null;
      const cached = details?.['cached_tokens'] ?? usage.data['prompt_cache_hit_tokens'] ?? 0;
      if (details?.['cached_tokens'] !== undefined && usage.data['prompt_cache_hit_tokens'] !== undefined && details['cached_tokens'] !== usage.data['prompt_cache_hit_tokens']) return null;
      if (typeof cached !== 'number' || !Number.isSafeInteger(cached) || cached < 0 || cached > usage.data.prompt_tokens) return null;
      const dimensions = [
        { field: 'input', tokens: usage.data.prompt_tokens - cached, usdPerMillionTokens: rates.input },
        { field: 'cached-input', tokens: cached, usdPerMillionTokens: rates.cachedInput },
        { field: 'output', tokens: usage.data.completion_tokens, usdPerMillionTokens: rates.output },
      ];
      const exactMinorUnits = measuredTariffExactMinorUnits(dimensions);
      return parseProviderSpendTariffMeasurement({ schemaVersion: 1, basis: 'measured-tariff', currency: quote.currency,
        exactMinorUnits, roundedMinorUnits: ceilProviderSpendExactMinorUnits(exactMinorUnits), quoteDigest: providerSpendQuoteDigest(quote),
        requestDigest: quote.requestDigest, profileDigest: quote.profileDigest, responseContentDigest: contentDigest,
        source: { id: 'openai-compatible-usage-tariff', version: 1, modelId: prepared.request.model, tariffDigest: quote.pricing.digest,
          tier: null, cacheSplit: 'none', dimensions } });
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
      return usage ? measure(token, usage, contentDigest) : null;
    },
    observeSpending(token: unknown, response: ModelInvocationNativeResponse) {
      const digest = modelInvocationResponseContentDescriptor(response).digest;
      return responses.get(token as object) === digest ? measure(token, response.usage, digest) : null;
    },
  };
  return Object.freeze({ native: Object.freeze(native), quote(input: ModelInvocationSpendingInput) {
    const prepared = input.prepared as PreparedOpenAiChatRequest;
    if (!prepared || typeof prepared !== 'object' || profiles.get(prepared) !== input.profileDigest
      || !isDeepStrictEqual(prepared.request, parseOpenAiChatTextRequest(input.command.nativeRequest, prepared.definition))) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
    const quote = quoteOpenAiChatOperatorTariff(input); quotes.set(prepared, quote); return quote;
  } });
}
