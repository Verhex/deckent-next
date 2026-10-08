import { anthropicResponseSpendMeasurement, anthropicSpendMeasurement, anthropicUsageForSpending } from './measurement.js';
import type { AnthropicUsage } from './assemble.js';
import { z } from 'zod';
import { modelInvocationResponseContentDescriptor, type ModelInvocationNativePort, type ModelInvocationSpendingInput } from '#engine/index.js';
import { modelInvocationProfileSchema, parseModelBindingDefinition, type ModelInvocationNativeResponse, type ModelInvocationDeltaSink, type ModelInvocationNativeResult, type ProviderSpendQuote } from '#domain/index.js';
import { NativeJsonHttpError, sendNativeJsonHttp } from '#adapters/core/provider-http-json/index.js';
import { OPENAI_CHAT_ENABLE_THINKING_CAPABILITY, OPENAI_CHAT_TOKEN_COUNT_CAPABILITY, OPENAI_CHAT_TOOL_CALLS_CAPABILITY, OpenAiChatHttpError,
  openAiChatWireObjectSchema, parseOpenAiChatTextRequest, type OpenAiChatHttpErrorCode, type OpenAiChatHttpLimits, type OpenAiChatTextRequest } from '#adapters/core/provider-openai-chat/index.js';
import { ANTHROPIC_MESSAGES_FAMILY, ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID, ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION, ANTHROPIC_MESSAGES_PROTOCOL_VERSION,
  parseAnthropicMessagesDefinition, parseAnthropicMessagesLimits, type AnthropicMessagesDefinition } from './contract.js';
import { anthropicPrefixDigest } from './continuation.js';
import { anthropicMessagesBody } from './messages.js';
import { parseAnthropicMessageResponse } from './response.js';
import { createAnthropicMessagesStream } from './stream.js';
import { quoteAnthropicPublishedTariff } from './tariff.js';

export interface AnthropicMessagesNativeOptions {
  readonly resolveCredential?: (reference: string, signal?: AbortSignal) => Promise<string | undefined>;
}
export type PreparedAnthropicRequest = Readonly<{ definition: AnthropicMessagesDefinition; limits: OpenAiChatHttpLimits; request: OpenAiChatTextRequest;
  body: string; wire: Record<string, unknown>; scopeId: string; prefixDigest: string }>;
const VERSION_HEADERS = Object.freeze({ 'anthropic-version': ANTHROPIC_MESSAGES_PROTOCOL_VERSION });
const adapter = Object.freeze({ id: ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID, version: ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION });
const countSchema = z.object({ input_tokens: z.number().int().nonnegative().safe() }).passthrough();
const COUNT_RESPONSE_MAX_BYTES = 64 * 1024;
/** Deadline of a counter (same shape as the OpenAI one): 2 s plus 250 ms per KiB of request, at most 30 s. */
const countTimeoutMs = (bodyBytes: number) => Math.min(30_000, 2_000 + Math.ceil(bodyBytes / 1024) * 250);

async function countPrepared(prepared: PreparedAnthropicRequest, options: AnthropicMessagesNativeOptions, signal?: AbortSignal) {
  const endpoint = prepared.definition.tokenCountEndpoint;
  if (!endpoint) return null;
  // The counter takes the request without its generation controls: same model, system, messages, tools and thinking as sent.
  const body = JSON.stringify(Object.fromEntries(Object.entries(prepared.wire).filter(([key]) => !['max_tokens', 'stream', 'cache_control'].includes(key))));
  try {
    const result = await sendNativeJsonHttp({ definition: { endpoint, authentication: prepared.definition.authentication, ...(prepared.definition.tls ? { tls: prepared.definition.tls } : {}) },
      limits: { requestMaxBytes: prepared.limits.requestMaxBytes, responseMaxBytes: COUNT_RESPONSE_MAX_BYTES, timeoutMs: countTimeoutMs(Buffer.byteLength(body, 'utf8')) },
      body, adapter, headers: VERSION_HEADERS },
    { ...(options.resolveCredential ? { resolveCredential: options.resolveCredential } : {}), parseResponse: raw => {
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return { reason: 'invalid-response' }; }
      const parsed = countSchema.safeParse(value);
      return parsed.success ? { response: { schemaVersion: 1, native: { count: parsed.data.input_tokens }, usage: null } } : { reason: 'invalid-response' };
    } }, signal);
    if ('kind' in result) return null;
    // The count is an estimate; the window is the profile's, so the provider reports none.
    return Object.freeze({ promptTokens: (result.native as { count: number }).count, windowTokens: null });
  } catch { return null; }
}

async function sendPrepared(prepared: PreparedAnthropicRequest, options: AnthropicMessagesNativeOptions, signal?: AbortSignal, onDelta?: ModelInvocationDeltaSink, onFinalUsage?: (usage: AnthropicUsage) => void) {
  try {
    const definition = { endpoint: prepared.definition.endpoint, authentication: prepared.definition.authentication,
      ...(prepared.definition.tls ? { tls: prepared.definition.tls } : {}) };
    return await sendNativeJsonHttp({ definition, limits: prepared.limits, body: prepared.body, adapter, headers: VERSION_HEADERS },
      prepared.request.stream === true
        ? { ...options, stream: createAnthropicMessagesStream(prepared.request, prepared.limits, { scopeId: prepared.scopeId, prefixDigest: prepared.prefixDigest }, onFinalUsage), ...(onDelta ? { onDelta } : {}) }
        : { ...options, parseResponse: body => parseAnthropicMessageResponse(body, prepared.request, prepared.limits, { scopeId: prepared.scopeId, prefixDigest: prepared.prefixDigest }) }, signal);
  } catch (error) {
    if (!(error instanceof NativeJsonHttpError)) throw error;
    throw new OpenAiChatHttpError(error.code.replace('NATIVE_JSON_HTTP_', 'OPENAI_CHAT_') as OpenAiChatHttpErrorCode, error.status);
  }
}

export interface AnthropicMessagesPricedNative {
  readonly native: ModelInvocationNativePort;
  /** Pure quote of the exact prepared request this instance issued. Budget authority stays in composition/engine. */
  quote(input: ModelInvocationSpendingInput): ProviderSpendQuote;
}

/** The native port and its quote resolver share one registry of prepared tokens, so a quote is always of the request that is sent. */
export function createAnthropicMessagesPricedNative(options: AnthropicMessagesNativeOptions = {}): AnthropicMessagesPricedNative {
  const responses = new WeakMap<object, string>();
  /** Only the final cumulative usage of a send (never the interim `message_start` count) backs a cut stream's settlement. */
  const usage = new WeakMap<object, unknown>();
  const quotes = new WeakMap<object, ProviderSpendQuote>();
  const tokens = new WeakMap<object, PreparedAnthropicRequest>(), countable = new WeakSet<object>();
  const read = (token: unknown) => {
    const value = token && typeof token === 'object' ? tokens.get(token) : undefined;
    if (!value) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
    return value;
  };
  const native: ModelInvocationNativePort = Object.freeze({
    responseBytesUpperBound(prepared: unknown): bigint {
      const cap = BigInt(read(prepared).limits.responseMaxBytes);
      // usage is null or an unchanged native subtree. Its serialized size cannot exceed native's size.
      const wrapper = BigInt(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, native: null, usage: null }), 'utf8'));
      return wrapper - 8n + cap + (cap > 4n ? cap : 4n);
    },
    async prepare(profile: unknown, definition: unknown, nativeRequest: unknown): Promise<unknown> {
      const envelope = openAiChatWireObjectSchema.safeParse(profile);
      if (!envelope.success) throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
      const parsedProfile = modelInvocationProfileSchema.safeParse(envelope.data);
      if (!parsedProfile.success || parsedProfile.data.adapter.id !== ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID || parsedProfile.data.adapter.version !== ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION
        || parsedProfile.data.protocol.family !== ANTHROPIC_MESSAGES_FAMILY || parsedProfile.data.protocol.version !== ANTHROPIC_MESSAGES_PROTOCOL_VERSION) {
        throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
      }
      const definitionEnvelope = openAiChatWireObjectSchema.safeParse(definition);
      if (!definitionEnvelope.success) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      let binding: ReturnType<typeof parseModelBindingDefinition>;
      try { binding = parseModelBindingDefinition(definitionEnvelope.data); } catch { throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID'); }
      const adapterDefinition = parseAnthropicMessagesDefinition(parsedProfile.data.adapter.definition);
      const limits = parseAnthropicMessagesLimits(parsedProfile.data.limits);
      const request = parseOpenAiChatTextRequest(nativeRequest, adapterDefinition);
      // The pinned model, the catalog binding and the tariff row must all name the same model: a price never applies to another model.
      if (request.model !== binding.model.nativeId || request.model !== adapterDefinition.tariff.modelId) throw new OpenAiChatHttpError('OPENAI_CHAT_MODEL_MISMATCH');
      const declares = (id: string) => binding.model.protocols.some(protocol => protocol.family === ANTHROPIC_MESSAGES_FAMILY
        && protocol.capabilities.some(capability => capability.id === id && capability.version === 1 && capability.state === 'supported'));
      if ((request.tools && !declares(OPENAI_CHAT_TOOL_CALLS_CAPABILITY))
        || (request.chat_template_kwargs && !declares(OPENAI_CHAT_ENABLE_THINKING_CAPABILITY))) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      const wire = anthropicMessagesBody(request, adapterDefinition, parsedProfile.data.scopeId);
      const body = JSON.stringify(wire);
      if (Buffer.byteLength(body, 'utf8') > limits.requestMaxBytes) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_TOO_LARGE');
      const prepared: PreparedAnthropicRequest = Object.freeze({ definition: adapterDefinition, limits, request, body, wire, scopeId: parsedProfile.data.scopeId,
        prefixDigest: anthropicPrefixDigest(wire['system'], wire['tools'], wire['messages']) });
      const token = Object.freeze({});
      tokens.set(token, prepared);
      if (adapterDefinition.tokenCountEndpoint && declares(OPENAI_CHAT_TOKEN_COUNT_CAPABILITY)) countable.add(token);
      return token;
    },
    async send(token: unknown, signal?: AbortSignal, onDelta?: ModelInvocationDeltaSink): Promise<ModelInvocationNativeResult> {
      const prepared = read(token); tokens.delete(token as object);
      const result = await sendPrepared(prepared, options, signal, onDelta, value => { const normalized = anthropicUsageForSpending(value); if (normalized) usage.set(token as object, normalized); });
      if (!('kind' in result)) responses.set(token as object, modelInvocationResponseContentDescriptor(result).digest);
      return result;
    },
    observeSpending(token: unknown, response: ModelInvocationNativeResponse) {
      const quote = quotes.get(token as object);
      if (responses.get(token as object) !== modelInvocationResponseContentDescriptor(response).digest) return null;
      return quote ? anthropicResponseSpendMeasurement(quote, response) : null;
    },
    observePartialSpending(token: unknown, contentDigest: string) {
      const quote = quotes.get(token as object), partial = usage.get(token as object);
      return quote && partial ? anthropicSpendMeasurement(quote, partial, contentDigest) : null;
    },
    async measure(token: unknown, signal?: AbortSignal) {
      const prepared = read(token); tokens.delete(token as object);
      return countable.has(token as object) ? countPrepared(prepared, options, signal) : null;
    },
  });
  return Object.freeze({ native, quote: (input: ModelInvocationSpendingInput) => {
    const quote = quoteAnthropicPublishedTariff(input, read(input.prepared)); quotes.set(input.prepared as object, quote); return quote;
  } });
}
