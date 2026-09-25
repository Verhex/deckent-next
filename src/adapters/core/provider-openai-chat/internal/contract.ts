import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { createImmutableJsonObjectSchema, MODEL_INVOCATION_NATIVE_JSON_LIMITS, type JsonObject } from '#domain/index.js';

export const OPENAI_CHAT_HTTP_ADAPTER_ID = 'openai-chat-http' as const;
export const OPENAI_CHAT_HTTP_ADAPTER_VERSION = 4 as const;
export const OPENAI_CHAT_COMPLETIONS_FAMILY = 'openai-chat-completions' as const;
export const OPENAI_CHAT_COMPLETIONS_VERSION = 'v1' as const;
export const OPENAI_CHAT_WIRE_LIMITS = MODEL_INVOCATION_NATIVE_JSON_LIMITS;

export type OpenAiChatHttpErrorCode = 'OPENAI_CHAT_DEFINITION_INVALID' | 'OPENAI_CHAT_REQUEST_INVALID'
  | 'OPENAI_CHAT_REQUEST_TOO_LARGE' | 'OPENAI_CHAT_RESPONSE_TOO_LARGE' | 'OPENAI_CHAT_TIMEOUT'
  | 'OPENAI_CHAT_CANCELLED' | 'OPENAI_CHAT_TRANSPORT_UNKNOWN'
  | 'OPENAI_CHAT_MODEL_MISMATCH' | 'OPENAI_CHAT_CREDENTIAL_UNAVAILABLE' | 'OPENAI_CHAT_CREDENTIAL_ECHO';

/** Error details deliberately exclude provider bodies, prompts, headers, and credentials. */
export class OpenAiChatHttpError extends Error {
  constructor(readonly code: OpenAiChatHttpErrorCode, readonly status?: number) { super(code); this.name = 'OpenAiChatHttpError'; }
}

export type OpenAiChatHttpAuthentication = Readonly<{ type: 'none' } | { type: 'bearer'; credentialRef: string }>;
/** Operator-declared tariff for servers without a provider price feed. v1 admits only zero rates (free/local models). */
export type OpenAiChatOperatorTariff = Readonly<{ kind: 'operator-static'; version: 1; currency: string;
  inputMinorUnitsPerMillionTokens: 0; outputMinorUnitsPerMillionTokens: 0 }>;
export type OpenAiChatHttpDefinition = Readonly<{ endpoint: string; maxOutputTokens: number;
  authentication: OpenAiChatHttpAuthentication; tls?: Readonly<{ caPem: string }>; tariff: OpenAiChatOperatorTariff }>;
export type OpenAiChatHttpLimits = Readonly<{ requestMaxBytes: number; responseMaxBytes: number; timeoutMs: number }>;
export type OpenAiChatToolCall = Readonly<{ id: string; type: 'function'; function: Readonly<{ name: string; arguments: string }> }>;
export type OpenAiChatTextMessage = Readonly<{ role: 'developer' | 'system' | 'user'; content: string }>
  | Readonly<{ role: 'assistant'; content: string | null; tool_calls?: readonly OpenAiChatToolCall[] }>
  | Readonly<{ role: 'tool'; tool_call_id: string; content: string }>;
export type OpenAiChatToolDefinition = Readonly<{ type: 'function'; function: Readonly<{ name: string; description?: string; parameters: JsonObject }> }>;
/** `stream: true` requires `stream_options.include_usage` so every streamed call ends with settleable usage. `tools` is sent only
 * when the model binding declares the `tool-calls` capability (T-L2); without it the adapter keeps refusing any tool call. */
export type OpenAiChatTextRequest = Readonly<{ model: string; messages: readonly OpenAiChatTextMessage[];
  max_completion_tokens: number; stream?: boolean; stream_options?: Readonly<{ include_usage: true }>; n?: 1;
  tools?: readonly OpenAiChatToolDefinition[]; tool_choice?: 'auto' | 'none' | 'required' }>;
/** Tool names follow the agent tool contract; ids are the provider's opaque correlation strings. */
export const OPENAI_CHAT_TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;
export const OPENAI_CHAT_MAX_TOOLS = 128, OPENAI_CHAT_MAX_TOOL_CALLS = 128;
/** Catalog capability a model binding must declare (state supported) before any tool definition is sent to it. */
export const OPENAI_CHAT_TOOL_CALLS_CAPABILITY = 'tool-calls';
export type OpenAiChatHttpResponse = Readonly<{ schemaVersion: 1; native: JsonObject; usage: JsonObject | null }>;

const positive = z.number().int().positive().safe();
const credentialReference = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
const certificate = z.string().min(1).max(65_536).refine(value => {
  if ((value.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1
    || (value.match(/-----END CERTIFICATE-----/g) ?? []).length !== 1 || value.includes('PRIVATE KEY')) return false;
  try {
    const parsed = new X509Certificate(value), canonical = (text: string) => text.replace(/\r\n/g, '\n').trimEnd();
    return canonical(value) === canonical(parsed.toString());
  } catch { return false; }
});
const tariffSchema = z.object({ kind: z.literal('operator-static'), version: z.literal(1), currency: z.string().regex(/^[A-Z]{3}$/),
  inputMinorUnitsPerMillionTokens: z.literal(0), outputMinorUnitsPerMillionTokens: z.literal(0) }).strict();
const definitionSchema = z.object({ endpoint: z.string().min(1), maxOutputTokens: positive,
  authentication: z.discriminatedUnion('type', [z.object({ type: z.literal('none') }).strict(),
    z.object({ type: z.literal('bearer'), credentialRef: credentialReference }).strict()]),
  tls: z.object({ caPem: certificate }).strict().optional(), tariff: tariffSchema }).strict();
const limitsSchema = z.object({ requestMaxBytes: positive, responseMaxBytes: positive,
  timeoutMs: positive.max(2_147_483_647) }).strict();
const toolCallSchema = z.object({ id: z.string().min(1).max(256), type: z.literal('function'),
  function: z.object({ name: z.string().regex(OPENAI_CHAT_TOOL_NAME), arguments: z.string() }).strict() }).strict();
const messageSchema = z.union([
  z.object({ role: z.enum(['developer', 'system', 'user']), content: z.string().min(1) }).strict(),
  z.object({ role: z.literal('assistant'), content: z.string().nullable(), tool_calls: z.array(toolCallSchema).min(1).max(OPENAI_CHAT_MAX_TOOL_CALLS).optional() }).strict()
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
  tool_choice: z.union([z.literal('auto'), z.literal('none'), z.literal('required')]).optional() }).strict()
  .refine(value => (value.stream === true) === (value.stream_options !== undefined))
  .refine(value => value.tool_choice === undefined || value.tools !== undefined)
  .refine(value => value.tools === undefined || new Set(value.tools.map(tool => tool.function.name)).size === value.tools.length)
  // A conversation that already carries tool traffic can only continue with tools declared.
  .refine(value => value.tools !== undefined || value.messages.every(message => message.role !== 'tool' && !('tool_calls' in message && message.tool_calls)));
export const openAiChatWireObjectSchema = createImmutableJsonObjectSchema(OPENAI_CHAT_WIRE_LIMITS);
export const openAiChatFinishReasonSchema = z.enum(['stop', 'length', 'content_filter', 'tool_calls']);
export const openAiChatUsageSchema = z.object({ prompt_tokens: z.number().int().nonnegative().safe(),
  completion_tokens: z.number().int().nonnegative().safe(), total_tokens: z.number().int().nonnegative().safe() }).passthrough()
  .superRefine((usage, context) => { if (usage.total_tokens < usage.prompt_tokens + usage.completion_tokens) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'USAGE_TOTAL_INVALID' });
  } });

export function parseOpenAiChatHttpDefinition(input: unknown): OpenAiChatHttpDefinition {
  const copied = openAiChatWireObjectSchema.safeParse(input), parsed = copied.success && definitionSchema.safeParse(copied.data);
  if (!parsed || !parsed.success || !isCanonicalEndpoint(parsed.data.endpoint, parsed.data.authentication.type, parsed.data.tls !== undefined)) {
    throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  }
  const authentication = Object.freeze({ ...parsed.data.authentication });
  return Object.freeze({ endpoint: parsed.data.endpoint, maxOutputTokens: parsed.data.maxOutputTokens, authentication,
    ...(parsed.data.tls ? { tls: Object.freeze({ ...parsed.data.tls }) } : {}), tariff: Object.freeze({ ...parsed.data.tariff }) });
}

export function parseOpenAiChatHttpLimits(input: unknown): OpenAiChatHttpLimits {
  const copied = openAiChatWireObjectSchema.safeParse(input), parsed = copied.success && limitsSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  return Object.freeze(parsed.data);
}

export function parseOpenAiChatTextRequest(input: unknown, definition: OpenAiChatHttpDefinition): OpenAiChatTextRequest {
  const copied = openAiChatWireObjectSchema.safeParse(input), parsed = copied.success && requestSchema.safeParse(copied.data);
  if (!parsed || !parsed.success || parsed.data.max_completion_tokens > definition.maxOutputTokens) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  const deepFreeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const entry of Object.values(value)) deepFreeze(entry); Object.freeze(value); } return value; };
  const data = structuredClone(parsed.data) as z.infer<typeof requestSchema>;
  return deepFreeze({ model: data.model, messages: data.messages as OpenAiChatTextMessage[],
    max_completion_tokens: data.max_completion_tokens, ...(data.stream === undefined ? {} : { stream: data.stream }),
    ...(data.stream === true ? { stream_options: { include_usage: true as const } } : {}),
    ...(data.n === 1 ? { n: 1 as const } : {}), ...(data.tools ? { tools: data.tools as OpenAiChatToolDefinition[] } : {}),
    ...(data.tool_choice ? { tool_choice: data.tool_choice } : {}) });
}

function isCanonicalEndpoint(endpoint: string, authentication: 'none' | 'bearer', hasTls: boolean): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  const common = url.search === '' && url.hash === '' && url.username === '' && url.password === ''
    && !endpoint.includes('?') && !endpoint.includes('#') && url.href === endpoint;
  if (!common) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && authentication === 'none' && !hasTls
    && (url.hostname === '127.0.0.1' || url.hostname === '[::1]') && url.port !== '' && Number(url.port) > 0;
}
