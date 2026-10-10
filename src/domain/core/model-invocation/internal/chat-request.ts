import { z } from 'zod';
import { createImmutableJsonObjectSchema, type JsonObject } from '#domain/core/primitives/index.js';
import { MODEL_INVOCATION_NATIVE_JSON_LIMITS } from './contract.js';

export type OpenAiChatHttpErrorCode = 'OPENAI_CHAT_DEFINITION_INVALID' | 'OPENAI_CHAT_REQUEST_INVALID'
  | 'OPENAI_CHAT_REQUEST_TOO_LARGE' | 'OPENAI_CHAT_RESPONSE_TOO_LARGE' | 'OPENAI_CHAT_TIMEOUT'
  | 'OPENAI_CHAT_CANCELLED' | 'OPENAI_CHAT_TRANSPORT_UNKNOWN'
  | 'OPENAI_CHAT_MODEL_MISMATCH' | 'OPENAI_CHAT_CREDENTIAL_UNAVAILABLE' | 'OPENAI_CHAT_CREDENTIAL_ECHO' | 'OPENAI_CHAT_CACHE_SALT_UNAVAILABLE';

/** Error details deliberately exclude provider bodies, prompts, headers, and credentials. */
export class OpenAiChatHttpError extends Error {
  constructor(readonly code: OpenAiChatHttpErrorCode, readonly status?: number) { super(code); this.name = 'OpenAiChatHttpError'; }
}

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type OpenAiChatToolCall = Readonly<{ id: string; type: 'function'; function: Readonly<{ name: string; arguments: string }> }>;
export type OpenAiChatTextMessage = Readonly<{ role: 'developer' | 'system' | 'user'; content: string }>
  | Readonly<{ role: 'assistant'; content: string | null; tool_calls?: readonly OpenAiChatToolCall[]; reasoning_content?: string | null; reasoning_details?: readonly JsonObject[] }>
  | Readonly<{ role: 'tool'; tool_call_id: string; content: string }>;
export type OpenAiChatToolDefinition = Readonly<{ type: 'function'; function: Readonly<{ name: string; description?: string; parameters: JsonObject }> }>;
/** `stream: true` requires `stream_options.include_usage` so every streamed call ends with settleable usage. `tools` is sent only
 * when the model binding declares the `tool-calls` capability (T-L2); without it the adapter keeps refusing any tool call.
 * `chat_template_kwargs.enable_thinking` likewise only to a binding that declares `chat-template-enable-thinking` (TL-C). */
export type OpenAiChatTextRequest = Readonly<{ model: string; messages: readonly OpenAiChatTextMessage[];
  max_completion_tokens: number; stream?: boolean; stream_options?: Readonly<{ include_usage: true }>; n?: 1;
  tools?: readonly OpenAiChatToolDefinition[]; tool_choice?: 'auto' | 'none' | 'required';
  chat_template_kwargs?: Readonly<{ enable_thinking: boolean }>; reasoning_effort?: OpenAiReasoningEffort;
  service_tier?: 'auto' | 'default' | 'flex' | 'priority' }>;
/** Tool names follow the agent tool contract; ids are the provider's opaque correlation strings. */
export const OPENAI_CHAT_TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;
export const OPENAI_CHAT_MAX_TOOLS = 128, OPENAI_CHAT_MAX_TOOL_CALLS = 128;
const positive = z.number().int().positive().safe();
export const openAiReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const reasoningEffortSchema = openAiReasoningEffortSchema;
const toolCallSchema = z.object({ id: z.string().min(1).max(256), type: z.literal('function'),
  function: z.object({ name: z.string().regex(OPENAI_CHAT_TOOL_NAME), arguments: z.string() }).strict() }).strict();
const messageSchema = z.union([
  z.object({ role: z.enum(['developer', 'system', 'user']), content: z.string().min(1) }).strict(),
  z.object({ role: z.literal('assistant'), content: z.string().nullable(), tool_calls: z.array(toolCallSchema).min(1).max(OPENAI_CHAT_MAX_TOOL_CALLS).optional(),
    reasoning_content: z.string().nullable().optional(), reasoning_details: z.array(createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS)).optional() }).strict()
    .refine(message => (message.content !== null && message.content.length > 0) || message.tool_calls !== undefined),
  z.object({ role: z.literal('tool'), tool_call_id: z.string().min(1).max(256), content: z.string() }).strict(),
]);
const toolSchema = z.object({ type: z.literal('function'), function: z.object({ name: z.string().regex(OPENAI_CHAT_TOOL_NAME),
  description: z.string().max(4096).optional(), parameters: z.record(z.string(), z.unknown()) }).strict() }).strict();
const requestSchema = z.object({ model: z.string().min(1).max(1024), messages: z.array(messageSchema).min(1).max(100_000),
  max_completion_tokens: positive, stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.literal(true) }).strict().optional(),
  n: z.literal(1).optional(), tools: z.array(toolSchema).min(1).max(OPENAI_CHAT_MAX_TOOLS).optional(),
  // OpenAI wire vocabulary for tool_choice (protocol literals, not Deckent configuration values).
  tool_choice: z.union([z.literal('auto'), z.literal('none'), z.literal('required')]).optional(),
  chat_template_kwargs: z.object({ enable_thinking: z.boolean() }).strict().optional(), reasoning_effort: reasoningEffortSchema.optional(),
  // Vendor wire vocabulary; these are protocol literals, not Deckent config choices.
  service_tier: z.union([z.literal('auto'), z.literal('default'), z.literal('flex'), z.literal('priority')]).optional() }).strict()
  .refine(value => (value.stream === true) === (value.stream_options !== undefined))
  .refine(value => value.tool_choice === undefined || value.tools !== undefined)
  .refine(value => value.tools === undefined || new Set(value.tools.map(tool => tool.function.name)).size === value.tools.length)
  // A conversation that already carries tool traffic can only continue with tools declared.
  .refine(value => value.tools !== undefined || value.messages.every(message => message.role !== 'tool' && !('tool_calls' in message && message.tool_calls)));
export const openAiChatWireObjectSchema = createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS);

export function parseOpenAiChatProtocolRequest(input: unknown, definition: Readonly<{ maxOutputTokens: number }>, normalize: <T>(value: T) => T): OpenAiChatTextRequest {
  const copied = openAiChatWireObjectSchema.safeParse(input), parsed = copied.success && requestSchema.safeParse(copied.data);
  if (!parsed || !parsed.success || parsed.data.max_completion_tokens > definition.maxOutputTokens) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  const deepFreeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const entry of Object.values(value)) deepFreeze(entry); Object.freeze(value); } return value; };
  // SURROGATE-CUT: a lone UTF-16 surrogate (e.g. a persisted text cut inside an emoji) is sent as `\udXXX` and a provider tokenizer
  // rejects the whole request, so every string of the parsed request is made well-formed (U+FFFD) here, where every adapter that
  // serializes it — the body, the counter's body, the tariff's body digest, the Anthropic wire — reads it. The admitted command and
  // its request digest are unchanged: this is a pure, idempotent part of the encoding, so a replay of the same command sends the same bytes.
  const data = normalize(structuredClone(parsed.data)) as z.infer<typeof requestSchema>;
  return deepFreeze({ model: data.model, messages: data.messages as OpenAiChatTextMessage[],
    max_completion_tokens: data.max_completion_tokens, ...(data.stream === undefined ? {} : { stream: data.stream }),
    ...(data.stream === true ? { stream_options: { include_usage: true as const } } : {}),
    ...(data.n === 1 ? { n: 1 as const } : {}), ...(data.tools ? { tools: data.tools as OpenAiChatToolDefinition[] } : {}),
    ...(data.tool_choice ? { tool_choice: data.tool_choice } : {}),
    ...(data.chat_template_kwargs ? { chat_template_kwargs: { enable_thinking: data.chat_template_kwargs.enable_thinking } } : {}),
    ...(data.reasoning_effort ? { reasoning_effort: data.reasoning_effort } : {}), ...(data.service_tier ? { service_tier: data.service_tier } : {}) });
}


export type OpenAiChatHttpLimits = Readonly<{ requestMaxBytes: number; responseMaxBytes: number; timeoutMs: number }>;
/** Catalog capability a model binding must declare (state supported) before any tool definition is sent to it. */
export const OPENAI_CHAT_TOOL_CALLS_CAPABILITY = 'tool-calls';
/** The server counts tokens of a chat request (messages and tools, the same body the round sends) at `tokenizeEndpoint`. */
export const OPENAI_CHAT_TOKEN_COUNT_CAPABILITY = 'token-count';
/**
 * Typed reasoning control (TL-C, legacy 7108 descriptor `chat_template_kwargs.enable_thinking`): the served chat template reads
 * `enable_thinking`, so one request can switch hidden reasoning off. Declared by catalog data (owner or server evidence, e.g. a
 * template that reads the flag), never inferred from a model name; without it the adapter refuses the field.
 */
export const OPENAI_CHAT_ENABLE_THINKING_CAPABILITY = 'chat-template-enable-thinking';
/**
 * Per-scope prefix-cache isolation (vLLM `cache_salt`, docs.vllm.ai OpenAI-compatible server, 2026-10-07): the server salts its prefix
 * cache with the string, so a prompt prefix cached for one scope never serves (or times) another. Sent only to a binding whose catalog
 * data declares this capability; a server that does not know the field is never sent it.
 */
export const OPENAI_CHAT_PREFIX_CACHE_SALT_CAPABILITY = 'prefix-cache-salt';
export const openAiChatUsageSchema = z.object({ prompt_tokens: z.number().int().nonnegative().safe(),
  completion_tokens: z.number().int().nonnegative().safe(), total_tokens: z.number().int().nonnegative().safe() }).passthrough()
  .superRefine((usage, context) => { if (usage.total_tokens < usage.prompt_tokens + usage.completion_tokens) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'USAGE_TOTAL_INVALID' });
  } });

const limitsSchema = z.object({ requestMaxBytes: positive, responseMaxBytes: positive,
  timeoutMs: positive.max(2_147_483_647) }).strict();
export function parseOpenAiChatHttpLimits(input: unknown): OpenAiChatHttpLimits {
  const copied = openAiChatWireObjectSchema.safeParse(input), parsed = copied.success && limitsSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  return Object.freeze(parsed.data);
}


/**
 * A provider's documented request dialect (registry data, carried on the v5 profile): which field bounds the completion (`max_tokens` for
 * DeepSeek and Z.ai GLM, `max_completion_tokens` for OpenAI), whether a streamed request asks for usage with `stream_options.include_usage`
 * (`omit`: the provider has no such option and reports usage on its last chunk, e.g. Z.ai) and which `tool_choice` values it accepts.
 */
export type OpenAiChatDialect = Readonly<{ tokenLimitField: 'max_tokens' | 'max_completion_tokens'; streamUsage: 'include' | 'omit';
  toolChoice: readonly ('auto' | 'none' | 'required')[]; finalUsageChoice?: 'repeat-finish' | undefined; responseObject?: 'optional' | undefined;
  finishReasons?: readonly ('sensitive' | 'model_context_window_exceeded' | 'network_error' | 'insufficient_system_resource' | 'aborted')[] | undefined;
  /** v6 keeps the typed chat facade but speaks Responses on the wire. Model effort support is registry data. */
  protocol?: 'responses' | undefined; reasoningEfforts?: readonly OpenAiReasoningEffort[] | undefined; reasoningEffort?: OpenAiReasoningEffort | undefined }>;
export const openAiChatDialectSchema = z.object({ tokenLimitField: z.enum(['max_tokens', 'max_completion_tokens']), streamUsage: z.enum(['include', 'omit']),
  // OpenAI wire vocabulary for tool_choice (protocol literals, not Deckent configuration values).
  toolChoice: z.array(z.union([z.literal('auto'), z.literal('none'), z.literal('required')])).min(1).max(3)
    .refine(values => new Set(values).size === values.length), finalUsageChoice: z.literal('repeat-finish').optional(), responseObject: z.literal('optional').optional(),
  finishReasons: z.array(z.enum(['sensitive', 'model_context_window_exceeded', 'network_error', 'insufficient_system_resource', 'aborted'])).max(5).optional(),
  protocol: z.literal('responses').optional(), reasoningEfforts: z.array(reasoningEffortSchema).min(1).max(7)
    .refine(values => new Set(values).size === values.length).readonly().optional(), reasoningEffort: reasoningEffortSchema.optional() }).strict()
  .refine(d => d.protocol === 'responses' ? d.reasoningEfforts !== undefined && d.reasoningEffort !== undefined && d.reasoningEfforts.includes(d.reasoningEffort)
    && d.finalUsageChoice === undefined : d.reasoningEfforts === undefined && d.reasoningEffort === undefined);
/** The OpenAI wire itself: what a v4 profile (no dialect) is sent. */
export const OPENAI_CHAT_DEFAULT_DIALECT: OpenAiChatDialect = Object.freeze({ tokenLimitField: 'max_completion_tokens', streamUsage: 'include',
  toolChoice: Object.freeze(['auto', 'none', 'required'] as const) });
