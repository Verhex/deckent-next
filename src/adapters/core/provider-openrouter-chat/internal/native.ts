import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { modelInvocationProfileSchema, parseModelBindingDefinition, parseProviderSpendQuote,
  type ModelBindingDefinition, type ModelInvocationProfile, type ModelInvocationNativeResponse, type ProviderSpendQuote } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, providerSpendEvidenceDigest,
  providerSpendQuoteDigest, parseProviderSpendReportedMeasurement, modelInvocationResponseContentDescriptor,
  type ModelInvocationNativePort, type ModelInvocationSpendingInput } from '#engine/index.js';
import { parseNativeJsonHttpLimits, sendNativeJsonHttp, type NativeJsonHttpRequest } from '#adapters/core/provider-http-json/index.js';
import { requireOpenRouterMetadataObservation, parseOpenRouterTextRequest, quoteOpenRouterText, openRouterReportedExactMinorUnits,
  type OpenRouterMetadataObservation, type OpenRouterTextReservation } from '#adapters/core/provider-openrouter-pricing/index.js';
import { OPENROUTER_CHAT_HTTP_ADAPTER_ID, OPENROUTER_CHAT_HTTP_ADAPTER_VERSION, OPENROUTER_CHAT_PROTOCOL,
  OpenRouterChatError, openRouterChatJsonSchema, parseOpenRouterChatDefinition } from './contract.js';
import { parseOpenRouterChatResponse } from './response.js';
import { observeOpenRouterUsage, openRouterResponseDigest, type OpenRouterUsageObservation } from './usage.js';

export interface OpenRouterNativeOptions {
  /** Pure access to a previously completed metadata acquisition; never fetch from this callback. */
  readonly currentObservation: () => OpenRouterMetadataObservation;
  readonly now: () => number;
  readonly resolveCredential?: (reference: string, signal?: AbortSignal) => Promise<string | undefined>;
}
export interface OpenRouterPricedNative {
  readonly native: ModelInvocationNativePort;
  /** Pure quote of the exact adapter-recognized prepared request. Budget authority remains in composition/engine. */
  quote(input: ModelInvocationSpendingInput): ProviderSpendQuote;
  /** Captured from this exact successful send. Pure observation; no settlement or invoice authority. */
  usageEvidence(prepared: unknown, response: ModelInvocationNativeResponse): OpenRouterUsageObservation;
}
interface Prepared {
  readonly profile: ModelInvocationProfile; readonly binding: ModelBindingDefinition;
  readonly request: ReturnType<typeof parseOpenRouterTextRequest>; readonly wire: NativeJsonHttpRequest;
  readonly observation: OpenRouterMetadataObservation; readonly reservation: OpenRouterTextReservation;
}

export function createOpenRouterPricedNative(options: OpenRouterNativeOptions): OpenRouterPricedNative {
  const { currentObservation, now, resolveCredential } = options;
  if (typeof currentObservation !== 'function' || typeof now !== 'function'
    || resolveCredential !== undefined && typeof resolveCredential !== 'function') throw new OpenRouterChatError('INVALID_PROFILE');
  const tokens = new WeakMap<object, Prepared>();
  const completed = new WeakMap<object, Readonly<{ responseDigest: string; observation: OpenRouterUsageObservation }>>();
  const quotes = new WeakMap<object, ProviderSpendQuote>();
  const usageEvidence = (prepared: unknown, response: ModelInvocationNativeResponse): OpenRouterUsageObservation => {
    const captured = prepared && typeof prepared === 'object' ? completed.get(prepared) : undefined;
    if (!captured || captured.responseDigest !== openRouterResponseDigest(response)) throw new OpenRouterChatError('INVALID_REQUEST');
    return captured.observation;
  };
  const read = (token: unknown) => {
    if (!token || typeof token !== 'object') throw new OpenRouterChatError('INVALID_REQUEST');
    const value = tokens.get(token);
    if (!value) throw new OpenRouterChatError('INVALID_REQUEST');
    return value;
  };
  const fresh = (value: Prepared) => {
    const current = requireOpenRouterMetadataObservation(currentObservation());
    if (current.sourceEndpoint !== value.observation.sourceEndpoint
      || current.tariff.tariffDigest !== value.observation.tariff.tariffDigest) throw new OpenRouterChatError('TARIFF_CONFLICT');
    const quote = quoteOpenRouterText(value.observation.tariff, value.request, now());
    if (!isDeepStrictEqual(quote, value.reservation)) throw new OpenRouterChatError('TARIFF_CONFLICT');
  };
  const native: ModelInvocationNativePort = Object.freeze({
    async prepare(profileInput: unknown, bindingInput: unknown, requestInput: unknown) {
      const envelope = openRouterChatJsonSchema.safeParse(profileInput), result = envelope.success && modelInvocationProfileSchema.safeParse(envelope.data);
      if (!result || !result.success || result.data.adapter.id !== OPENROUTER_CHAT_HTTP_ADAPTER_ID
        || result.data.adapter.version !== OPENROUTER_CHAT_HTTP_ADAPTER_VERSION || !isDeepStrictEqual(result.data.protocol, OPENROUTER_CHAT_PROTOCOL)) {
        throw new OpenRouterChatError('INVALID_PROFILE');
      }
      const profile = result.data, binding = parseModelBindingDefinition(bindingInput), definition = parseOpenRouterChatDefinition(profile.adapter.definition);
      const request = parseOpenRouterTextRequest(requestInput), observation = requireOpenRouterMetadataObservation(currentObservation());
      if (observation.sourceEndpoint !== definition.metadataEndpoint || observation.tariff.selection.endpointTag !== definition.endpointTag
        || binding.model.nativeId !== request.model || request.model !== observation.tariff.selection.modelId) throw new OpenRouterChatError('TARIFF_CONFLICT');
      const requestedOutput = request.max_tokens ?? request.max_completion_tokens!;
      if (requestedOutput > definition.maxOutputTokens) throw new OpenRouterChatError('INVALID_REQUEST');
      const reservation = quoteOpenRouterText(observation.tariff, request, now());
      const body = JSON.stringify({ ...request, stream: false, provider: { ...reservation.provider, order: reservation.provider.only } });
      const limits = parseNativeJsonHttpLimits(profile.limits);
      if (Buffer.byteLength(body, 'utf8') > limits.requestMaxBytes) throw new OpenRouterChatError('REQUEST_TOO_LARGE');
      const wire = Object.freeze({ definition: definition.transport, limits, body,
        adapter: Object.freeze({ id: OPENROUTER_CHAT_HTTP_ADAPTER_ID, version: OPENROUTER_CHAT_HTTP_ADAPTER_VERSION }) });
      const token = Object.freeze({});
      tokens.set(token, Object.freeze({ profile, binding, request, wire, observation, reservation })); return token;
    },
    responseBytesUpperBound(token: unknown) {
      const cap = BigInt(read(token).wire.limits.responseMaxBytes);
      return BigInt(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, native: null, usage: null }), 'utf8')) - 8n + cap + (cap > 4n ? cap : 4n);
    },
    async send(token: unknown, signal?: AbortSignal) {
      const value = read(token); tokens.delete(token as object); fresh(value);
      let observation: OpenRouterUsageObservation | undefined;
      const result = await sendNativeJsonHttp(value.wire, {
        ...(resolveCredential ? { resolveCredential } : {}),
        parseResponse: body => {
          const parsed = parseOpenRouterChatResponse(body, value.request.model, value.wire.limits.responseMaxBytes);
          if ('response' in parsed) observation = observeOpenRouterUsage(body, parsed.response, {
            profileDigest: modelInvocationProfileDigest(value.profile), tariffDigest: value.observation.tariff.tariffDigest,
            requestBodyDigest: createHash('sha256').update(value.wire.body).digest('hex'),
            selectedEndpointTag: value.observation.tariff.selection.endpointTag,
          });
          return parsed;
        },
      }, signal);
      // Publish only after transport returns success, including all credential-echo and response checks.
      if (!('kind' in result) && observation) completed.set(token as object,
        Object.freeze({ responseDigest: openRouterResponseDigest(result), observation }));
      return result;
    },
    observeSpending(prepared: unknown, response: ModelInvocationNativeResponse) {
      const observed = usageEvidence(prepared, response);
      if (observed.kind === 'hold') return null;
      const quote = quotes.get(prepared as object);
      if (!quote) throw new OpenRouterChatError('INVALID_REQUEST');
      const evidence = observed.evidence, source = evidence.source;
      // Financial retention is an explicit scalar allowlist. Never copy native usage extensions across content purge.
      return parseProviderSpendReportedMeasurement({ schemaVersion: 1, basis: 'provider-reported', currency: evidence.currency,
        exactMinorUnits: openRouterReportedExactMinorUnits(source.numericSource), roundedMinorUnits: evidence.roundedChargeMinorUnits,
        quoteDigest: providerSpendQuoteDigest(quote), requestDigest: quote.requestDigest, profileDigest: evidence.context.profileDigest,
        responseContentDigest: modelInvocationResponseContentDescriptor(response).digest,
        source: { id: 'openrouter-account-charge', version: 1, field: source.field, generationId: source.generationId, modelId: source.modelId,
          numericSource: source.numericSource, minorUnitsPerCurrencyUnit: 100, bodyDigest: source.bodyDigest, responseDigest: source.responseDigest,
          requestBodyDigest: evidence.context.requestBodyDigest, tariffDigest: evidence.context.tariffDigest,
          selectedEndpointTag: evidence.context.selectedEndpointTag } });
    },
  });
  return Object.freeze({ native, usageEvidence, quote(input: ModelInvocationSpendingInput): ProviderSpendQuote {
    const value = read(input.prepared); fresh(value);
    if (!isDeepStrictEqual(input.profile, value.profile) || !isDeepStrictEqual(input.definition, value.binding)
      || !isDeepStrictEqual(parseOpenRouterTextRequest(input.command.nativeRequest), value.request)
      || !isDeepStrictEqual(input.command.reference, value.profile.reference)
      || input.command.expectedBinding.digest !== value.profile.bindingDigest
      || input.command.scopeId !== value.profile.scopeId || modelInvocationRequestDigest(input.command) !== input.requestDigest
      || modelInvocationProfileDigest(input.profile) !== input.profileDigest) throw new OpenRouterChatError('TARIFF_CONFLICT');
    const evidence = { schemaVersion: 1, sourceEndpoint: value.observation.sourceEndpoint,
      observedAtMs: value.observation.observedAtMs, sourceBodyDigest: value.observation.sourceBodyDigest,
      tariffDigest: value.reservation.tariffDigest, bodyDigest: createHash('sha256').update(value.wire.body).digest('hex'),
      pricedDimensions: value.observation.tariff.pricedDimensions, unpricedDimensions: value.observation.tariff.unpricedDimensions,
      calculation: { schemaVersion: 1, currency: 'USD', minorUnitsPerCurrencyUnit: 100, rounding: 'ceil-per-dimension',
        inputRates: ['prompt', 'input_cache_read', 'input_cache_write'], outputRates: ['completion', 'internal_reasoning'],
        inputBound: 'published-endpoint-prompt-or-context', outputBound: 'requested-output-tokens', requestCount: 1 },
      reservation: value.reservation };
    const evidenceDigest = providerSpendEvidenceDigest(evidence);
    const quote = parseProviderSpendQuote({ schemaVersion: 1, scopeId: input.command.scopeId, requestDigest: input.requestDigest, profileDigest: input.profileDigest,
      pricing: { id: 'openrouter-endpoint-tariff', version: 1, digest: value.reservation.tariffDigest, definition: value.observation.tariff.definition },
      meter: { id: 'openrouter-text-reservation', version: 1, evidenceDigest, evidence },
      currency: value.reservation.currency, maxChargeMinorUnits: value.reservation.maxChargeMinorUnits });
    quotes.set(input.prepared as object, quote);
    return quote;
  } });
}
