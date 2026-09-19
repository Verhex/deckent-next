import { Agent, request as httpRequest } from 'node:http';
import { z } from 'zod';
import type { ModelInvocationNativePort } from '#engine/index.js';
import { modelInvocationProfileSchema, parseModelBindingDefinition } from '#domain/index.js';
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

async function sendPreparedOpenAiChatHttpRequest(prepared: PreparedOpenAiChatRequest, signal?: AbortSignal): Promise<OpenAiChatHttpResponse> {
  if (signal?.aborted) throw new OpenAiChatHttpError('OPENAI_CHAT_CANCELLED');
  const endpoint = new URL('/v1/chat/completions', prepared.definition.origin);
  return new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false, proxyEnv: {} });
    let settled = false; let response: import('node:http').IncomingMessage | undefined;
    const done = (error?: OpenAiChatHttpError, value?: OpenAiChatHttpResponse) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      agent.destroy();
      if (error) { response?.destroy(); req.destroy(); reject(error); } else if (value) resolve(value);
    };
    const abort = () => done(new OpenAiChatHttpError('OPENAI_CHAT_CANCELLED'));
    const req = httpRequest(endpoint, { agent, method: 'POST', headers: { 'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(prepared.body, 'utf8')), accept: 'application/json' } }, incoming => {
      response = incoming; const status = incoming.statusCode ?? 0; const chunks: Buffer[] = []; let bytes = 0;
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > prepared.limits.responseMaxBytes) done(new OpenAiChatHttpError('OPENAI_CHAT_RESPONSE_TOO_LARGE'));
        else chunks.push(chunk);
      });
      incoming.on('error', () => done(new OpenAiChatHttpError('OPENAI_CHAT_TRANSPORT_UNKNOWN')));
      incoming.on('end', () => {
        if (settled) return;
        if (status >= 300 && status < 400) { done(new OpenAiChatHttpError('OPENAI_CHAT_REDIRECT_UNKNOWN', status)); return; }
        if (status < 200 || status >= 300) { done(new OpenAiChatHttpError('OPENAI_CHAT_HTTP_UNKNOWN', status)); return; }
        try { done(undefined, parseResponse(Buffer.concat(chunks), prepared)); } catch (error) {
          done(error instanceof OpenAiChatHttpError ? error : new OpenAiChatHttpError('OPENAI_CHAT_RESPONSE_INVALID'));
        }
      });
    });
    const timer = setTimeout(() => done(new OpenAiChatHttpError('OPENAI_CHAT_TIMEOUT')), prepared.limits.timeoutMs);
    req.on('error', () => done(new OpenAiChatHttpError('OPENAI_CHAT_TRANSPORT_UNKNOWN')));
    signal?.addEventListener('abort', abort, { once: true }); req.end(prepared.body);
  });
}

function parseResponse(body: Buffer, prepared: PreparedOpenAiChatRequest): OpenAiChatHttpResponse {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw new OpenAiChatHttpError('OPENAI_CHAT_RESPONSE_INVALID'); }
  const copied = openAiChatWireObjectSchema.safeParse(raw), parsed = copied.success && responseSchema.safeParse(copied.data);
  if (!parsed || !parsed.success || parsed.data.model !== prepared.request.model) throw new OpenAiChatHttpError(
    parsed && parsed.success ? 'OPENAI_CHAT_MODEL_MISMATCH' : 'OPENAI_CHAT_RESPONSE_INVALID');
  const choice = parsed.data.choices[0]!;
  if ('tool_calls' in choice.message || 'function_call' in choice.message) {
    throw new OpenAiChatHttpError('OPENAI_CHAT_RESPONSE_INVALID');
  }
  if (parsed.data.usage === undefined || parsed.data.usage === null) return Object.freeze({ schemaVersion: 1, native: copied.data, usage: null });
  const usageCopied = openAiChatWireObjectSchema.safeParse(parsed.data.usage), usage = usageCopied.success && usageSchema.safeParse(usageCopied.data);
  if (!usage || !usage.success || usage.data.completion_tokens > prepared.request.max_completion_tokens) {
    throw new OpenAiChatHttpError('OPENAI_CHAT_RESPONSE_INVALID');
  }
  return Object.freeze({ schemaVersion: 1, native: copied.data, usage: usageCopied.data });
}

export const openAiChatProtocol = Object.freeze({ family: OPENAI_CHAT_COMPLETIONS_FAMILY, version: OPENAI_CHAT_COMPLETIONS_VERSION });

/** Structural native port for the engine resolver. Only preparation validates the profile and binding; it has no network effect. */
export function createOpenAiChatNativePort(): ModelInvocationNativePort {
  const preparedTokens = new WeakSet<object>();
  return Object.freeze({
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
    async send(prepared: unknown, signal?: AbortSignal): Promise<OpenAiChatHttpResponse> {
      if (!prepared || typeof prepared !== 'object' || !preparedTokens.has(prepared)) {
        throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      }
      preparedTokens.delete(prepared); return sendPreparedOpenAiChatHttpRequest(prepared as PreparedOpenAiChatRequest, signal);
    },
  });
}
