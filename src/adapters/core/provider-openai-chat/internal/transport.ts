import { z } from 'zod';
import type { ModelInvocationNativePort } from '#engine/index.js';
import { modelInvocationProfileSchema, parseModelBindingDefinition, type ModelInvocationDeltaSink, type ModelInvocationNativeResult } from '#domain/index.js';
import { NativeJsonHttpError, sendNativeJsonHttp } from '#adapters/core/provider-http-json/index.js';
import { OPENAI_CHAT_HTTP_ADAPTER_ID, OPENAI_CHAT_HTTP_ADAPTER_VERSION, OPENAI_CHAT_COMPLETIONS_FAMILY, OPENAI_CHAT_COMPLETIONS_VERSION, OpenAiChatHttpError,
  OPENAI_CHAT_TOOL_CALLS_CAPABILITY,
  openAiChatFinishReasonSchema, openAiChatUsageSchema, openAiChatWireObjectSchema, parseOpenAiChatHttpDefinition, parseOpenAiChatHttpLimits, parseOpenAiChatTextRequest,
  type OpenAiChatHttpDefinition, type OpenAiChatHttpErrorCode, type OpenAiChatHttpLimits,
  type OpenAiChatHttpResponse, type OpenAiChatTextRequest } from './contract.js';
import { createOpenAiChatStream } from './stream.js';
import { checkedToolCalls } from './tool-calls.js';

export type PreparedOpenAiChatRequest = Readonly<{ definition: OpenAiChatHttpDefinition; limits: OpenAiChatHttpLimits;
  request: OpenAiChatTextRequest; body: string }>;
export interface OpenAiChatNativePortOptions {
  readonly resolveCredential?: (reference: string, signal?: AbortSignal) => Promise<string | undefined>;
}
const finishReason = openAiChatFinishReasonSchema, usageSchema = openAiChatUsageSchema;
const messageSchema = z.object({ role: z.literal('assistant'), content: z.string().nullable(), refusal: z.string().nullable().optional() }).passthrough();
const choiceSchema = z.object({ index: z.literal(0), finish_reason: finishReason, message: messageSchema }).passthrough();
const responseSchema = z.object({ id: z.string().min(1), object: z.literal('chat.completion'), created: z.number().int().nonnegative().safe(),
  model: z.string().min(1), choices: z.array(choiceSchema).length(1), usage: z.unknown().optional() }).passthrough();

/** Pure preparation: it has no network, credential, or profile-resolution effect. */
export function prepareOpenAiChatHttpRequest(definitionInput: unknown, limitsInput: unknown, nativeRequestInput: unknown): PreparedOpenAiChatRequest {
  const definition = parseOpenAiChatHttpDefinition(definitionInput), limits = parseOpenAiChatHttpLimits(limitsInput);
  const nativeRequest = parseOpenAiChatTextRequest(nativeRequestInput, definition);
  const streamed = nativeRequest.stream === true;
  const body = JSON.stringify({ model: nativeRequest.model, messages: nativeRequest.messages,
    max_completion_tokens: nativeRequest.max_completion_tokens, stream: streamed,
    ...(streamed ? { stream_options: { include_usage: true } } : {}), ...(nativeRequest.n === 1 ? { n: 1 } : {}),
    ...(nativeRequest.tools ? { tools: nativeRequest.tools } : {}), ...(nativeRequest.tool_choice ? { tool_choice: nativeRequest.tool_choice } : {}) });
  if (Buffer.byteLength(body, 'utf8') > limits.requestMaxBytes) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_TOO_LARGE');
  return Object.freeze({ definition, limits, request: nativeRequest, body });
}

function parseResponse(body: Buffer, prepared: PreparedOpenAiChatRequest): { response: OpenAiChatHttpResponse } | { reason: 'invalid-response' | 'model-mismatch' | 'response-limit' } {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return { reason: 'invalid-response' }; }
  const copied = openAiChatWireObjectSchema.safeParse(raw), parsed = copied.success && responseSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) return { reason: 'invalid-response' };
  if (parsed.data.model !== prepared.request.model) return { reason: 'model-mismatch' };
  // JSON serialization can expand numeric wire spellings. Bound the representation actually persisted/delivered too.
  if (Buffer.byteLength(JSON.stringify(copied.data), 'utf8') > prepared.limits.responseMaxBytes) {
    return { reason: 'response-limit' };
  }
  const choice = parsed.data.choices[0]!;
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
    return await sendNativeJsonHttp({ definition, limits: prepared.limits, body: prepared.body,
      adapter: { id: OPENAI_CHAT_HTTP_ADAPTER_ID, version: OPENAI_CHAT_HTTP_ADAPTER_VERSION } },
    // A streamed request is parsed incrementally whether or not a caller observes its deltas.
    prepared.request.stream === true
      ? { ...options, stream: createOpenAiChatStream(prepared.request, prepared.limits), ...(onDelta ? { onDelta } : {}) }
      : { ...options, parseResponse: body => parseResponse(body, prepared) }, signal);
  } catch (error) {
    if (!(error instanceof NativeJsonHttpError)) throw error;
    const code = error.code.replace('NATIVE_JSON_HTTP_', 'OPENAI_CHAT_') as OpenAiChatHttpErrorCode;
    throw new OpenAiChatHttpError(code, error.status);
  }
}

export const openAiChatProtocol = Object.freeze({ family: OPENAI_CHAT_COMPLETIONS_FAMILY, version: OPENAI_CHAT_COMPLETIONS_VERSION });

/** Structural native port for the engine resolver. Only preparation validates the profile and binding; it has no network effect. */
export function createOpenAiChatNativePort(options: OpenAiChatNativePortOptions = {}): ModelInvocationNativePort {
  const preparedTokens = new WeakSet<object>();
  return Object.freeze({
    responseBytesUpperBound(prepared: unknown): bigint {
      if (!prepared || typeof prepared !== 'object' || !preparedTokens.has(prepared)) {
        throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      }
      const cap = BigInt((prepared as PreparedOpenAiChatRequest).limits.responseMaxBytes);
      // usage is null or an unchanged native subtree. Its serialized size cannot exceed native's size.
      const wrapper = BigInt(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, native: null, usage: null }), 'utf8'));
      return wrapper - 8n + cap + (cap > 4n ? cap : 4n);
    },
    async prepare(profile: unknown, definition: unknown, nativeRequest: unknown): Promise<unknown> {
      const profileEnvelope = openAiChatWireObjectSchema.safeParse(profile);
      if (!profileEnvelope.success) throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
      const parsedProfile = modelInvocationProfileSchema.safeParse(profileEnvelope.data);
      if (!parsedProfile.success || parsedProfile.data.adapter.id !== OPENAI_CHAT_HTTP_ADAPTER_ID || parsedProfile.data.adapter.version !== OPENAI_CHAT_HTTP_ADAPTER_VERSION
        || parsedProfile.data.protocol.family !== OPENAI_CHAT_COMPLETIONS_FAMILY || parsedProfile.data.protocol.version !== OPENAI_CHAT_COMPLETIONS_VERSION) {
        throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
      }
      const definitionEnvelope = openAiChatWireObjectSchema.safeParse(definition);
      if (!definitionEnvelope.success) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      let binding: ReturnType<typeof parseModelBindingDefinition>;
      try { binding = parseModelBindingDefinition(definitionEnvelope.data); }
      catch { throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID'); }
      const adapterDefinition = parseOpenAiChatHttpDefinition(parsedProfile.data.adapter.definition);
      const request = parseOpenAiChatTextRequest(nativeRequest, adapterDefinition);
      if (request.model !== binding.model.nativeId) throw new OpenAiChatHttpError('OPENAI_CHAT_MODEL_MISMATCH');
      // Tools are sent only to a model whose binding declares tool calling as supported (catalog data, not a request flag).
      if (request.tools && !binding.model.protocols.some(protocol => protocol.family === OPENAI_CHAT_COMPLETIONS_FAMILY
        && protocol.capabilities.some(capability => capability.id === OPENAI_CHAT_TOOL_CALLS_CAPABILITY && capability.version === 1 && capability.state === 'supported'))) {
        throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      }
      const prepared = prepareOpenAiChatHttpRequest(adapterDefinition, parsedProfile.data.limits, request);
      preparedTokens.add(prepared); return prepared;
    },
    async send(prepared: unknown, signal?: AbortSignal, onDelta?: ModelInvocationDeltaSink): Promise<ModelInvocationNativeResult> {
      if (!prepared || typeof prepared !== 'object' || !preparedTokens.has(prepared)) {
        throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      }
      preparedTokens.delete(prepared); return sendPreparedOpenAiChatHttpRequest(prepared as PreparedOpenAiChatRequest, options, signal, onDelta);
    },
  });
}
