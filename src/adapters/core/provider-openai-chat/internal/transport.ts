import { OPENAI_RESERVATION_POLICY } from './reservation-policy.js';
import { z } from 'zod';
import { responseDialect, finishReasonAccepted, reasoningDetailsSchema } from './response-dialect.js';
import { modelInvocationNativeResponseUpperBound, type ModelInvocationNativePort } from '#engine/index.js';
import { modelInvocationProfileSchema, parseModelBindingDefinition, type ModelInvocationDeltaSink, type ModelInvocationNativeResult, type JsonObject } from '#domain/index.js';
import { NativeJsonHttpError, sendNativeJsonHttp } from '#adapters/core/provider-http-json/index.js';
import { OPENAI_CHAT_DEFAULT_DIALECT, isOpenAiChatHttpAdapter, OPENAI_CHAT_HTTP_ADAPTER_ID, OPENAI_CHAT_HTTP_ADAPTER_VERSION, OPENAI_CHAT_COMPLETIONS_FAMILY, OPENAI_CHAT_COMPLETIONS_VERSION, OpenAiChatHttpError,
  OPENAI_CHAT_ENABLE_THINKING_CAPABILITY, OPENAI_CHAT_TOOL_CALLS_CAPABILITY, OPENAI_CHAT_TOKEN_COUNT_CAPABILITY, OPENAI_CHAT_PREFIX_CACHE_SALT_CAPABILITY,
  openAiChatUsageSchema, openAiChatWireObjectSchema, parseOpenAiChatHttpDefinition, parseOpenAiChatHttpLimits, parseOpenAiChatTextRequest,
  type OpenAiChatHttpDefinition, type OpenAiChatHttpErrorCode, type OpenAiChatHttpLimits,
  type OpenAiChatHttpResponse, type OpenAiChatTextRequest } from './contract.js';
import { createOpenAiChatStream } from './stream.js';
import { checkedToolCalls } from './tool-calls.js';
import { responsesBody, rememberResponsesOutput } from './responses-body.js';
import { parseResponsesResponse } from './responses-response.js';
import { createResponsesStream } from './responses-stream.js';

/** Evidence names the served profile version: v4 default chat, v5 chat dialect, v6 Responses dialect. */
const adapterOf = (definition: OpenAiChatHttpDefinition) => ({ id: OPENAI_CHAT_HTTP_ADAPTER_ID,
  version: definition.dialect?.protocol === 'responses' ? 6 : definition.dialect ? OPENAI_CHAT_HTTP_ADAPTER_VERSION : 4 });
export type PreparedOpenAiChatRequest = Readonly<{ definition: OpenAiChatHttpDefinition; limits: OpenAiChatHttpLimits;
  request: OpenAiChatTextRequest; body: string; scopeId?: string; reasoningInputTokensUpperBound?: number }>;
interface ProviderRequestFields {
  readonly provider: JsonObject;
  readonly modalities: readonly ['text'];
  readonly plugins: readonly Readonly<{ id: string; enabled: false }>[];
}
export interface OpenAiChatNativePortOptions {
  /** A streamed send's final usage only (seen with or after its finish reason) with the stream's authoritative service tier; an interim usage never reaches it. */
  readonly onFinalUsage?: (prepared: PreparedOpenAiChatRequest, usage: JsonObject, serviceTier?: unknown, frame?: string) => void;
  /** A contradiction after that final usage (e.g. a later conflicting service tier) withdraws it: it no longer settles money (Astra 2467). */
  readonly onFinalUsageWithdrawn?: (prepared: PreparedOpenAiChatRequest) => void;
  /** Pure pricing adapter ports: routing is appended before size checking; raw validated response bytes preserve monetary decimals. */
  readonly providerRequestFields?: (definition: OpenAiChatHttpDefinition, request: OpenAiChatTextRequest) => ProviderRequestFields;
  readonly onResponse?: (prepared: PreparedOpenAiChatRequest, body: Buffer, response: OpenAiChatHttpResponse) => void;
  readonly resolveCredential?: (reference: string, signal?: AbortSignal) => Promise<string | undefined>;
  /** The scope's secret prefix-cache salt (composition: HMAC under the installation's salt secret). Required by a binding that declares
   * prefix-cache-salt: without it, or when it fails, nothing is sent (fail closed, never a derivable salt). */
  readonly cacheSalt?: (scopeId: string) => Promise<string>;
}
const finishReason = z.string(), usageSchema = openAiChatUsageSchema;
const messageSchema = z.object({ role: z.literal('assistant'), content: z.string().nullable(), refusal: z.string().nullable().optional() }).passthrough();
const choiceSchema = z.object({ index: z.literal(0), finish_reason: finishReason, message: messageSchema }).passthrough();
const responseSchema = z.object({ id: z.string().min(1), object: z.literal('chat.completion').optional(), created: z.number().int().nonnegative().safe(),
  model: z.string().min(1), choices: z.array(choiceSchema).length(1), usage: z.unknown().optional() }).passthrough();

/** Largest `/tokenize` answer read (the server lists every token id: ~7 bytes each, so a 131k-token prompt is about 1 MiB). */
export const OPENAI_CHAT_TOKENIZE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const tokenizeSchema = z.object({ count: z.number().int().nonnegative().safe(), max_model_len: z.number().int().positive().safe().optional() }).passthrough();
/** Legacy deadline for a counter: 2 s plus 250 ms per KiB of request, at most 30 s (never the round's own timeout). */
const tokenizeTimeoutMs = (bodyBytes: number) => Math.min(30_000, 2_000 + Math.ceil(bodyBytes / 1024) * 250);

/**
 * Provider count of exactly what the round sends (T-L5): the same model, messages and tools as the prepared body, posted to the
 * same-origin `tokenizeEndpoint`. Any failure — status, timeout, cancel, malformed answer — is null: the caller then uses a tagged
 * upper bound, and a counter never fails a turn.
 */
async function countPreparedOpenAiChatRequest(prepared: PreparedOpenAiChatRequest, options: OpenAiChatNativePortOptions, signal?: AbortSignal) {
  const endpoint = prepared.definition.tokenizeEndpoint;
  if (!endpoint) return null;
  // The thinking switch changes the rendered prompt (an empty thinking block), so the count carries it too (measured = sent).
  const body = JSON.stringify({ model: prepared.request.model, messages: prepared.request.messages,
    ...(prepared.request.tools ? { tools: prepared.request.tools } : {}),
    ...(prepared.request.chat_template_kwargs ? { chat_template_kwargs: prepared.request.chat_template_kwargs } : {}) });
  try {
    const result = await sendNativeJsonHttp({ definition: { endpoint, authentication: prepared.definition.authentication,
      ...(prepared.definition.tls ? { tls: prepared.definition.tls } : {}) },
    limits: { requestMaxBytes: prepared.limits.requestMaxBytes, responseMaxBytes: OPENAI_CHAT_TOKENIZE_RESPONSE_MAX_BYTES,
      timeoutMs: tokenizeTimeoutMs(Buffer.byteLength(body, 'utf8')) },
    body, adapter: adapterOf(prepared.definition) },
    { ...(options.resolveCredential ? { resolveCredential: options.resolveCredential } : {}), parseResponse: raw => {
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return { reason: 'invalid-response' }; }
      const parsed = tokenizeSchema.safeParse(value);
      if (!parsed.success) return { reason: 'invalid-response' };
      return { response: { schemaVersion: 1, native: { count: parsed.data.count, maxModelLen: parsed.data.max_model_len ?? null }, usage: null } };
    } }, signal);
    if ('kind' in result) return null;
    const native = result.native as { count: number; maxModelLen: number | null };
    return Object.freeze({ promptTokens: native.count, windowTokens: native.maxModelLen });
  } catch { return null; }
}

/** The salt of one scope from the composition port: 43-character base64url (256 bit, within vLLM's 1..1024 bound), stable per scope and
 * installation secret. vLLM: "treat the salt as a secret" — a public formula of the scope id is refused by construction (no fallback). */
async function secretCacheSalt(options: OpenAiChatNativePortOptions, scopeId: string): Promise<string> {
  if (!options.cacheSalt) throw new OpenAiChatHttpError('OPENAI_CHAT_CACHE_SALT_UNAVAILABLE');
  const salt = await options.cacheSalt(scopeId);
  if (typeof salt !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(salt)) throw new OpenAiChatHttpError('OPENAI_CHAT_CACHE_SALT_UNAVAILABLE');
  return salt;
}

/** Pure preparation: it has no network, credential, or profile-resolution effect. */
export function prepareOpenAiChatHttpRequest(definitionInput: unknown, limitsInput: unknown, nativeRequestInput: unknown, cacheSalt?: string,
  providerFields?: ProviderRequestFields, scopeId?: string): PreparedOpenAiChatRequest {
  const definition = parseOpenAiChatHttpDefinition(definitionInput), limits = parseOpenAiChatHttpLimits(limitsInput);
  const nativeRequest = parseOpenAiChatTextRequest(nativeRequestInput, definition);
  const streamed = nativeRequest.stream === true, dialect = definition.dialect ?? OPENAI_CHAT_DEFAULT_DIALECT;
  // K1 (v5): the provider's documented dialect shapes the wire; the admitted request (and its digest) is the same for every provider.
  if (nativeRequest.tool_choice && !dialect.toolChoice.includes(nativeRequest.tool_choice)) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  const responses = dialect.protocol === 'responses';
  const tiered = definition.tariff.kind === 'vendor-published' && definition.tariff.version === 2;
  if (!responses && (nativeRequest.reasoning_effort !== undefined || (nativeRequest.service_tier !== undefined && !tiered))) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  if (responses && (cacheSalt !== undefined || providerFields !== undefined || definition.tokenizeEndpoint !== undefined)) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  const encoded = responses ? responsesBody(definition, nativeRequest, scopeId) : null;
  const body = JSON.stringify(encoded ? encoded.body : { model: nativeRequest.model, messages: nativeRequest.messages,
    [dialect.tokenLimitField]: nativeRequest.max_completion_tokens, stream: streamed,
    ...(tiered ? { service_tier: nativeRequest.service_tier ?? OPENAI_RESERVATION_POLICY.expectedServiceTier } : {}),
    ...(streamed && dialect.streamUsage === 'include' ? { stream_options: { include_usage: true } } : {}), ...(nativeRequest.n === 1 ? { n: 1 } : {}),
    ...(nativeRequest.tools ? { tools: nativeRequest.tools } : {}), ...(nativeRequest.tool_choice ? { tool_choice: nativeRequest.tool_choice } : {}),
    ...(nativeRequest.chat_template_kwargs ? { chat_template_kwargs: nativeRequest.chat_template_kwargs } : {}),
    ...(cacheSalt ? { cache_salt: cacheSalt } : {}), ...(providerFields ?? {}) });
  if ((definition.tariff.kind === 'openrouter-endpoint') !== (providerFields !== undefined)) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  if (Buffer.byteLength(body, 'utf8') > limits.requestMaxBytes) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_TOO_LARGE');
  return Object.freeze({ definition, limits, request: nativeRequest, body, ...(scopeId ? { scopeId } : {}),
    ...(encoded ? { reasoningInputTokensUpperBound: encoded.reasoningInputTokensUpperBound } : {}) });
}

function parseResponse(body: Buffer, prepared: PreparedOpenAiChatRequest): { response: OpenAiChatHttpResponse } | { reason: 'invalid-response' | 'model-mismatch' | 'response-limit' } {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return { reason: 'invalid-response' }; }
  const copied = openAiChatWireObjectSchema.safeParse(raw), parsed = copied.success && responseSchema.safeParse(copied.data);
  if (!parsed || !parsed.success || (copied.data['error'] !== undefined && copied.data['error'] !== null)) return { reason: 'invalid-response' };
  if (parsed.data.model !== prepared.request.model) return { reason: 'model-mismatch' };
  // JSON serialization can expand numeric wire spellings. Bound the representation actually persisted/delivered too.
  if (Buffer.byteLength(JSON.stringify(copied.data), 'utf8') > prepared.limits.responseMaxBytes) {
    return { reason: 'response-limit' };
  }
  const choice = parsed.data.choices[0]!, dialect = responseDialect(prepared.definition);
  if ((!parsed.data.object && dialect.responseObject !== 'optional') || !finishReasonAccepted(choice.finish_reason, dialect)
    || (choice.message['reasoning_details'] != null && !reasoningDetailsSchema.safeParse(choice.message['reasoning_details']).success)) return { reason: 'invalid-response' };
  // Servers such as vLLM always send these keys, as null, when there is none. The legacy function_call is never accepted;
  // tool_calls only when the request declared tools, and only for declared names (T-L2).
  if ((choice.message['function_call'] ?? null) !== null) return { reason: 'invalid-response' };
  const calls = checkedToolCalls(choice.message['tool_calls'] ?? null, prepared.request);
  if (calls === 'invalid' || (choice.finish_reason === 'tool_calls') !== (calls !== null)) return { reason: 'invalid-response' };
  if (parsed.data.usage === undefined || parsed.data.usage === null) return { response: Object.freeze({ schemaVersion: 1, native: copied.data, usage: null }) };
  const usageCopied = openAiChatWireObjectSchema.safeParse(parsed.data.usage), usage = usageCopied.success && usageSchema.safeParse(usageCopied.data);
  if (!usage || !usage.success || usage.data.completion_tokens > prepared.request.max_completion_tokens) {
    return { reason: 'invalid-response' };
  }
  return { response: Object.freeze({ schemaVersion: 1, native: copied.data, usage: usageCopied.data }) };
}

async function sendPreparedOpenAiChatHttpRequest(prepared: PreparedOpenAiChatRequest, options: OpenAiChatNativePortOptions,
  signal?: AbortSignal, onDelta?: ModelInvocationDeltaSink) {
  try {
    const definition = { endpoint: prepared.definition.endpoint, authentication: prepared.definition.authentication,
      ...(prepared.definition.tls ? { tls: prepared.definition.tls } : {}) };
    // Only the transport's own options cross into it (the salt port is a preparation input, not a transport option).
    const transport = options.resolveCredential ? { resolveCredential: options.resolveCredential } : {};
    const remember = (output: readonly Record<string, unknown>[], message: unknown) => {
      if (prepared.scopeId) rememberResponsesOutput(prepared.scopeId, prepared.definition, prepared.request, output, message);
    };
    if (prepared.definition.dialect?.protocol === 'responses') {
      return await sendNativeJsonHttp({ definition, limits: prepared.limits, body: prepared.body, adapter: adapterOf(prepared.definition) },
        prepared.request.stream === true ? { ...transport, stream: createResponsesStream(prepared.request, prepared.limits,
          (usage, tier) => options.onFinalUsage?.(prepared, usage, tier), () => options.onFinalUsageWithdrawn?.(prepared), remember),
          ...(onDelta ? { onDelta } : {}) } : { ...transport, parseResponse: body => {
            let raw: unknown;
            try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return { reason: 'invalid-response' }; }
            const result = parseResponsesResponse(raw, prepared.request, prepared.limits);
            if ('response' in result) {
              const value = raw as { output: Record<string, unknown>[] };
              remember(value.output, (result.response.native['choices'] as unknown as { message: unknown }[])[0]?.message);
              options.onResponse?.(prepared, body, result.response);
            }
            return result;
          } }, signal);
    }
    return await sendNativeJsonHttp({ definition, limits: prepared.limits, body: prepared.body,
      adapter: adapterOf(prepared.definition) },
    // A streamed request is parsed incrementally whether or not a caller observes its deltas.
    prepared.request.stream === true
      ? { ...transport, stream: createOpenAiChatStream(prepared.request, prepared.limits, (usage, serviceTier, frame) => options.onFinalUsage?.(prepared, usage, serviceTier, frame),
        () => options.onFinalUsageWithdrawn?.(prepared), responseDialect(prepared.definition)), ...(onDelta ? { onDelta } : {}) }
      : { ...transport, parseResponse: body => { const result = parseResponse(body, prepared);
        if ('response' in result) options.onResponse?.(prepared, body, result.response); return result; } }, signal);
  } catch (error) {
    if (!(error instanceof NativeJsonHttpError)) throw error;
    const code = error.code.replace('NATIVE_JSON_HTTP_', 'OPENAI_CHAT_') as OpenAiChatHttpErrorCode;
    throw new OpenAiChatHttpError(code, error.status);
  }
}

export const openAiChatProtocol = Object.freeze({ family: OPENAI_CHAT_COMPLETIONS_FAMILY, version: OPENAI_CHAT_COMPLETIONS_VERSION });

/** Structural native port for the engine resolver. Only preparation validates the profile and binding; it has no network effect. */
export function createOpenAiChatNativePort(options: OpenAiChatNativePortOptions = {}): ModelInvocationNativePort {
  const preparedTokens = new WeakSet<object>(), countable = new WeakSet<object>();
  return Object.freeze({
    responseBytesUpperBound(prepared: unknown): bigint {
      if (!prepared || typeof prepared !== 'object' || !preparedTokens.has(prepared)) {
        throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      }
      // usage is null or an unchanged native subtree; its serialized size cannot exceed native's size, so both
      // are bounded by the same declared response cap (shared formula: SESSION-RESULT-LIMIT-2026-09-28).
      return modelInvocationNativeResponseUpperBound((prepared as PreparedOpenAiChatRequest).limits.responseMaxBytes);
    },
    async prepare(profile: unknown, definition: unknown, nativeRequest: unknown): Promise<unknown> {
      const profileEnvelope = openAiChatWireObjectSchema.safeParse(profile);
      if (!profileEnvelope.success) throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
      const parsedProfile = modelInvocationProfileSchema.safeParse(profileEnvelope.data);
      if (!parsedProfile.success || !isOpenAiChatHttpAdapter(parsedProfile.data.adapter)
        || parsedProfile.data.protocol.family !== OPENAI_CHAT_COMPLETIONS_FAMILY || parsedProfile.data.protocol.version !== OPENAI_CHAT_COMPLETIONS_VERSION) {
        throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
      }
      const definitionEnvelope = openAiChatWireObjectSchema.safeParse(definition);
      if (!definitionEnvelope.success) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      let binding: ReturnType<typeof parseModelBindingDefinition>;
      try { binding = parseModelBindingDefinition(definitionEnvelope.data); }
      catch { throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID'); }
      const adapterDefinition = parseOpenAiChatHttpDefinition(parsedProfile.data.adapter.definition);
      // v5 carries its dialect; v4 never does (its wire is the OpenAI one, unchanged).
      if ((parsedProfile.data.adapter.version === 4) !== (adapterDefinition.dialect === undefined)
        || (parsedProfile.data.adapter.version === 6) !== (adapterDefinition.dialect?.protocol === 'responses')) throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
      const request = parseOpenAiChatTextRequest(nativeRequest, adapterDefinition);
      if (request.model !== binding.model.nativeId) throw new OpenAiChatHttpError('OPENAI_CHAT_MODEL_MISMATCH');
      const declares = (id: string) => binding.model.protocols.some(protocol => protocol.family === OPENAI_CHAT_COMPLETIONS_FAMILY
        && protocol.capabilities.some(capability => capability.id === id && capability.version === 1 && capability.state === 'supported'));
      // Tools and the thinking switch are sent only to a model whose binding declares them supported (catalog data, not a request flag).
      if ((request.tools && !declares(OPENAI_CHAT_TOOL_CALLS_CAPABILITY))
        || (request.chat_template_kwargs && !declares(OPENAI_CHAT_ENABLE_THINKING_CAPABILITY))) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      const prepared = prepareOpenAiChatHttpRequest(adapterDefinition, parsedProfile.data.limits, request,
        declares(OPENAI_CHAT_PREFIX_CACHE_SALT_CAPABILITY) ? await secretCacheSalt(options, parsedProfile.data.scopeId) : undefined,
        options.providerRequestFields?.(adapterDefinition, request), parsedProfile.data.scopeId);
      preparedTokens.add(prepared);
      // A counter is used only for a model whose binding declares it (catalog data) and a profile that names its endpoint.
      if (adapterDefinition.tokenizeEndpoint && declares(OPENAI_CHAT_TOKEN_COUNT_CAPABILITY)) countable.add(prepared);
      return prepared;
    },
    async send(prepared: unknown, signal?: AbortSignal, onDelta?: ModelInvocationDeltaSink): Promise<ModelInvocationNativeResult> {
      if (!prepared || typeof prepared !== 'object' || !preparedTokens.has(prepared)) {
        throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      }
      preparedTokens.delete(prepared); return sendPreparedOpenAiChatHttpRequest(prepared as PreparedOpenAiChatRequest, options, signal, onDelta);
    },
    async measure(prepared: unknown, signal?: AbortSignal) {
      if (!prepared || typeof prepared !== 'object' || !preparedTokens.has(prepared)) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      preparedTokens.delete(prepared);
      return countable.has(prepared) ? countPreparedOpenAiChatRequest(prepared as PreparedOpenAiChatRequest, options, signal) : null;
    },
  });
}
