import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, ModelInvocationNativeResponse, ProviderSpendQuote } from '#domain/index.js';
import { parseProviderSpendQuote } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, modelInvocationResponseContentDescriptor, providerSpendEvidenceDigest,
  providerSpendQuoteDigest, parseProviderSpendReportedMeasurement, type ModelInvocationNativePort, type ModelInvocationSpendingInput } from '#engine/index.js';
import { createOpenAiChatNativePort, parseOpenAiChatTextRequest, openAiChatWireObjectSchema,
  type OpenAiChatHttpDefinition, type OpenAiChatTextRequest, type PreparedOpenAiChatRequest } from '#adapters/core/provider-openai-chat/index.js';
import { requireOpenRouterMetadataObservation, quoteOpenRouterText, openRouterReportedExactMinorUnits,
  type OpenRouterMetadataObservation } from '#adapters/core/provider-openrouter-pricing/index.js';
import { OpenRouterChatError } from './contract.js';
import { observeOpenRouterUsage, type OpenRouterUsageObservation } from './usage.js';
import type { OpenRouterNativeOptions } from './native.js';

/** OpenRouter's money authority around the shared v5 tools/stream transport. No second parser or settlement owner. */
export function createOpenRouterOpenAiPricedNative(options: OpenRouterNativeOptions) {
  const owned = new WeakMap<object, Pick<ModelInvocationSpendingInput, 'profile' | 'definition' | 'profileDigest'>>(), observations = new WeakMap<object, OpenRouterMetadataObservation>();
  const quotes = new WeakMap<object, ProviderSpendQuote>(), captured = new WeakMap<object, OpenRouterUsageObservation>();
  const completed = new WeakMap<object, string>();
  const wireRequest = (definition: OpenAiChatHttpDefinition, request: OpenAiChatTextRequest) => {
    const { max_completion_tokens: output, ...rest } = request;
    return { ...rest, ...(request.stream === true ? { stream_options: { include_usage: true } } : {}),
      [definition.dialect!.tokenLimitField]: output };
  };
  const current = (definition: OpenAiChatHttpDefinition, request: OpenAiChatTextRequest) => {
    const tariff = definition.tariff, observation = requireOpenRouterMetadataObservation(options.currentObservation());
    if (tariff.kind !== 'openrouter-endpoint' || observation.sourceEndpoint !== tariff.metadataEndpoint
      || observation.tariff.selection.endpointTag !== tariff.endpointTag || observation.tariff.selection.modelId !== request.model) throw new OpenRouterChatError('TARIFF_CONFLICT');
    return observation;
  };
  const observe = (prepared: PreparedOpenAiChatRequest, body: Buffer, response: ModelInvocationNativeResponse) => {
    const input = owned.get(prepared), observation = observations.get(prepared);
    if (!input || !observation) return;
    captured.set(prepared, observeOpenRouterUsage(body, response, { profileDigest: input.profileDigest, tariffDigest: observation.tariff.tariffDigest,
      requestBodyDigest: createHash('sha256').update(prepared.body).digest('hex'), selectedEndpointTag: observation.tariff.selection.endpointTag }));
  };
  const delegate = createOpenAiChatNativePort({ ...(options.resolveCredential ? { resolveCredential: options.resolveCredential } : {}),
    providerRequestFields: (definition, request) => {
      const reservation = quoteOpenRouterText(current(definition, request).tariff, wireRequest(definition, request), options.now());
      return { provider: reservation.provider as JsonObject, ...reservation.requestControls };
    },
    onResponse: observe,
    onFinalUsage(prepared, usage, _tier, frame) {
      if (!frame) return;
      const native = openAiChatWireObjectSchema.parse(JSON.parse(frame));
      observe(prepared, Buffer.from(frame), { schemaVersion: 1, native, usage });
    },
    onFinalUsageWithdrawn: prepared => { captured.delete(prepared); },
  });
  const measure = (token: unknown, contentDigest: string) => {
    const observed = captured.get(token as object), quote = quotes.get(token as object);
    if (!quote || observed?.kind !== 'reported') return null;
    const evidence = observed.evidence, source = evidence.source;
    return parseProviderSpendReportedMeasurement({ schemaVersion: 1, basis: 'provider-reported', currency: 'USD',
      exactMinorUnits: openRouterReportedExactMinorUnits(source.numericSource), roundedMinorUnits: evidence.roundedChargeMinorUnits,
      quoteDigest: providerSpendQuoteDigest(quote), requestDigest: quote.requestDigest, profileDigest: quote.profileDigest,
      responseContentDigest: contentDigest, source: { id: 'openrouter-account-charge', version: 1, field: source.field,
        generationId: source.generationId, modelId: source.modelId, numericSource: source.numericSource, minorUnitsPerCurrencyUnit: 100,
        bodyDigest: source.bodyDigest, responseDigest: source.responseDigest, requestBodyDigest: evidence.context.requestBodyDigest,
        tariffDigest: evidence.context.tariffDigest, selectedEndpointTag: evidence.context.selectedEndpointTag } });
  };
  const fresh = (prepared: PreparedOpenAiChatRequest) => {
    const observed = observations.get(prepared);
    if (!observed) throw new OpenRouterChatError('INVALID_REQUEST');
    const now = current(prepared.definition, prepared.request);
    if (!observed || observed.tariff.tariffDigest !== now.tariff.tariffDigest) throw new OpenRouterChatError('TARIFF_CONFLICT');
    return quoteOpenRouterText(observed.tariff, wireRequest(prepared.definition, prepared.request), options.now());
  };
  const native: ModelInvocationNativePort = { ...delegate,
    async prepare(profile, binding, request) {
      const prepared = await delegate.prepare(profile, binding, request) as PreparedOpenAiChatRequest;
      observations.set(prepared, current(prepared.definition, prepared.request));
      owned.set(prepared, { profile, definition: binding, profileDigest: modelInvocationProfileDigest(profile) });
      return prepared;
    },
    async send(token, signal, onDelta) {
      fresh(token as PreparedOpenAiChatRequest);
      const result = await delegate.send(token, signal, onDelta);
      if (!('kind' in result)) completed.set(token as object, modelInvocationResponseContentDescriptor(result).digest);
      return result;
    },
    observeSpending(token, response) {
      const digest = modelInvocationResponseContentDescriptor(response).digest;
      return completed.get(token as object) === digest ? measure(token, digest) : null;
    },
    observePartialSpending: measure,
  };
  return Object.freeze({ native: Object.freeze(native), quote(input: ModelInvocationSpendingInput) {
    const prepared = input.prepared as PreparedOpenAiChatRequest, held = owned.get(prepared);
    if (!held || !isDeepStrictEqual(input.profile, held.profile) || !isDeepStrictEqual(input.definition, held.definition)
      || input.profileDigest !== held.profileDigest || modelInvocationRequestDigest(input.command) !== input.requestDigest
      || !isDeepStrictEqual(input.command.reference, input.profile.reference) || input.command.scopeId !== input.profile.scopeId
      || input.command.expectedBinding.digest !== input.profile.bindingDigest
      || !isDeepStrictEqual(prepared.request, parseOpenAiChatTextRequest(input.command.nativeRequest, prepared.definition))) throw new OpenRouterChatError('TARIFF_CONFLICT');
    const reservation = fresh(prepared), observation = observations.get(prepared)!;
    const evidence = { schemaVersion: 1, sourceEndpoint: observation.sourceEndpoint, observedAtMs: observation.observedAtMs,
      privacySourceEndpoint: observation.privacySourceEndpoint ?? null, privacyBodyDigest: observation.privacyBodyDigest ?? null,
      sourceBodyDigest: observation.sourceBodyDigest, tariffDigest: reservation.tariffDigest,
      bodyDigest: createHash('sha256').update(prepared.body).digest('hex'), reservation,
      calculation: { inputBound: 'published-endpoint-prompt-or-context-including-tools', outputBound: 'requested-output-tokens', requestCount: 1 } };
    const quote = parseProviderSpendQuote({ schemaVersion: 1, scopeId: input.command.scopeId, requestDigest: input.requestDigest, profileDigest: input.profileDigest,
      pricing: { id: 'openrouter-endpoint-tariff', version: observation.tariff.schemaVersion, digest: reservation.tariffDigest, definition: observation.tariff.definition },
      meter: { id: 'openrouter-chat-reservation', version: reservation.schemaVersion, evidenceDigest: providerSpendEvidenceDigest(evidence), evidence },
      currency: 'USD', maxChargeMinorUnits: reservation.maxChargeMinorUnits });
    quotes.set(prepared, quote); return quote;
  } });
}
