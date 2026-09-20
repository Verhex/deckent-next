import { Agent, request as httpRequest } from 'node:http';
import { z } from 'zod';
import { createModelInvocationResponseEvidence, type ModelInvocationNativePort } from '#engine/index.js';
import { modelInvocationProfileSchema, parseModelBindingDefinition, type ModelInvocationNativeResult, type ModelInvocationRejectionReason } from '#domain/index.js';
import { OPENAI_CHAT_HTTP_ADAPTER_ID, OPENAI_CHAT_HTTP_ADAPTER_VERSION, OPENAI_CHAT_COMPLETIONS_FAMILY, OPENAI_CHAT_COMPLETIONS_VERSION, OpenAiChatHttpError,
  openAiChatWireObjectSchema, parseOpenAiChatHttpDefinition, parseOpenAiChatHttpLimits, parseOpenAiChatTextRequest,
  type OpenAiChatHttpDefinition, type OpenAiChatHttpLimits, type OpenAiChatHttpResponse, type OpenAiChatTextRequest } from './contract.js';

export type PreparedOpenAiChatRequest = Readonly<{ definition: OpenAiChatHttpDefinition; limits: OpenAiChatHttpLimits;
  request: OpenAiChatTextRequest; body: string }>;
const finishReason = z.enum(['stop', 'length', 'content_filter']);
const usageSchema = z.object({ prompt_tokens: z.number().int().nonnegative().safe(),
  completion_tokens: z.number().int().nonnegative().safe(), total_tokens: z.number().int().nonnegative().safe() }).passthrough()
  .superRefine((usage, context) => { if (usage.total_tokens < usage.prompt_tokens + usage.completion_tokens) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'USAGE_TOTAL_INVALID' });
  } });
const messageSchema = z.object({ role: z.literal('assistant'), content: z.string().nullable(), refusal: z.string().nullable().optional() }).passthrough();
const choiceSchema = z.object({ index: z.literal(0), finish_reason: finishReason, message: messageSchema }).passthrough();
const responseSchema = z.object({ id: z.string().min(1), object: z.literal('chat.completion'), created: z.number().int().nonnegative().safe(),
  model: z.string().min(1), choices: z.array(choiceSchema).length(1), usage: z.unknown().optional() }).passthrough();

/** Pure preparation: it has no network, credential, or profile-resolution effect. */
export function prepareOpenAiChatHttpRequest(definitionInput: unknown, limitsInput: unknown, nativeRequestInput: unknown): PreparedOpenAiChatRequest {
  const definition = parseOpenAiChatHttpDefinition(definitionInput), limits = parseOpenAiChatHttpLimits(limitsInput);
  const nativeRequest = parseOpenAiChatTextRequest(nativeRequestInput, definition);
  const body = JSON.stringify({ model: nativeRequest.model, messages: nativeRequest.messages,
    max_completion_tokens: nativeRequest.max_completion_tokens, stream: false, ...(nativeRequest.n === 1 ? { n: 1 } : {}) });
  if (Buffer.byteLength(body, 'utf8') > limits.requestMaxBytes) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_TOO_LARGE');
  return Object.freeze({ definition, limits, request: nativeRequest, body });
}

function statusOf(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}
function rejected(reason: ModelInvocationRejectionReason, status: number | null,
  body: Uint8Array, complete: boolean, observedBytes = body.byteLength): ModelInvocationNativeResult {
  return Object.freeze({ kind: 'rejected' as const, evidence: createModelInvocationResponseEvidence(
    { id: OPENAI_CHAT_HTTP_ADAPTER_ID, version: OPENAI_CHAT_HTTP_ADAPTER_VERSION }, reason, status, body, complete, observedBytes), });
}

async function sendPreparedOpenAiChatHttpRequest(prepared: PreparedOpenAiChatRequest, signal?: AbortSignal): Promise<ModelInvocationNativeResult> {
  if (signal?.aborted) throw new OpenAiChatHttpError('OPENAI_CHAT_CANCELLED');
  const endpoint = new URL('/v1/chat/completions', prepared.definition.origin);
  return new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false, proxyEnv: {} });
    let settled = false; let response: import('node:http').IncomingMessage | undefined;
    const retained: Buffer[] = []; let retainedBytes = 0; let observedBytes = 0; let status: number | null = null;
    const retainedBody = () => Buffer.concat(retained);
    const done = (error?: OpenAiChatHttpError, value?: ModelInvocationNativeResult) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      agent.destroy();
      if (error) { response?.destroy(); req.destroy(); reject(error); } else if (value) resolve(value);
    };
    const settleRejected = (reason: ModelInvocationRejectionReason, complete: boolean) => {
      if (settled) return;
      try { done(undefined, rejected(reason, status, retainedBody(), complete, observedBytes)); }
      catch { done(new OpenAiChatHttpError('OPENAI_CHAT_RESPONSE_TOO_LARGE')); }
    };
    const interrupted = (error: OpenAiChatHttpError) => {
      if (settled) return;
      if (response && status !== null) settleRejected('interrupted', false);
      else done(error);
    };
    const abort = () => interrupted(new OpenAiChatHttpError('OPENAI_CHAT_CANCELLED'));
    const req = httpRequest(endpoint, { agent, method: 'POST', headers: { 'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(prepared.body, 'utf8')), accept: 'application/json' } }, incoming => {
      response = incoming; const currentStatus = statusOf(incoming.statusCode); status = currentStatus;
      if (currentStatus === null) { done(new OpenAiChatHttpError('OPENAI_CHAT_TRANSPORT_UNKNOWN')); return; }
      incoming.on('data', (chunk: Buffer) => {
        if (settled) return;
        observedBytes += chunk.byteLength;
        const remaining = prepared.limits.responseMaxBytes - retainedBytes;
        if (remaining > 0) { const prefix = chunk.subarray(0, remaining); retained.push(prefix); retainedBytes += prefix.byteLength; }
        if (observedBytes > prepared.limits.responseMaxBytes) {
          settleRejected('response-limit', false);
        }
      });
      incoming.on('error', () => { if (!settled) interrupted(new OpenAiChatHttpError('OPENAI_CHAT_TRANSPORT_UNKNOWN')); });
      incoming.on('end', () => {
        if (settled) return;
        try {
          if (currentStatus >= 300 && currentStatus < 400) { settleRejected('redirect', true); return; }
          if (currentStatus < 200 || currentStatus >= 300) { settleRejected('http-status', true); return; }
          const parsed = parseResponse(retainedBody(), prepared);
          if ('reason' in parsed) settleRejected(parsed.reason, true); else done(undefined, parsed.response);
        } catch { done(new OpenAiChatHttpError('OPENAI_CHAT_RESPONSE_TOO_LARGE')); }
      });
    });
    const timer = setTimeout(() => interrupted(new OpenAiChatHttpError('OPENAI_CHAT_TIMEOUT')), prepared.limits.timeoutMs);
    req.on('error', () => { if (!settled) interrupted(new OpenAiChatHttpError('OPENAI_CHAT_TRANSPORT_UNKNOWN')); });
    signal?.addEventListener('abort', abort, { once: true }); req.end(prepared.body);
  });
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
  if ('tool_calls' in choice.message || 'function_call' in choice.message) {
    return { reason: 'invalid-response' };
  }
  if (parsed.data.usage === undefined || parsed.data.usage === null) return { response: Object.freeze({ schemaVersion: 1, native: copied.data, usage: null }) };
  const usageCopied = openAiChatWireObjectSchema.safeParse(parsed.data.usage), usage = usageCopied.success && usageSchema.safeParse(usageCopied.data);
  if (!usage || !usage.success || usage.data.completion_tokens > prepared.request.max_completion_tokens) {
    return { reason: 'invalid-response' };
  }
  return { response: Object.freeze({ schemaVersion: 1, native: copied.data, usage: usageCopied.data }) };
}

export const openAiChatProtocol = Object.freeze({ family: OPENAI_CHAT_COMPLETIONS_FAMILY, version: OPENAI_CHAT_COMPLETIONS_VERSION });

/** Structural native port for the engine resolver. Only preparation validates the profile and binding; it has no network effect. */
export function createOpenAiChatNativePort(): ModelInvocationNativePort {
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
      const prepared = prepareOpenAiChatHttpRequest(adapterDefinition, parsedProfile.data.limits, request);
      preparedTokens.add(prepared); return prepared;
    },
    async send(prepared: unknown, signal?: AbortSignal): Promise<ModelInvocationNativeResult> {
      if (!prepared || typeof prepared !== 'object' || !preparedTokens.has(prepared)) {
        throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      }
      preparedTokens.delete(prepared); return sendPreparedOpenAiChatHttpRequest(prepared as PreparedOpenAiChatRequest, signal);
    },
  });
}
