import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { createImmutableJsonObjectSchema, MODEL_INVOCATION_NATIVE_JSON_LIMITS, type JsonObject } from '#domain/index.js';

export const OPENAI_CHAT_HTTP_ADAPTER_ID = 'openai-chat-http' as const;
export const OPENAI_CHAT_HTTP_ADAPTER_VERSION = 3 as const;
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
export type OpenAiChatHttpDefinition = Readonly<{ endpoint: string; maxOutputTokens: number;
  authentication: OpenAiChatHttpAuthentication; tls?: Readonly<{ caPem: string }> }>;
export type OpenAiChatHttpLimits = Readonly<{ requestMaxBytes: number; responseMaxBytes: number; timeoutMs: number }>;
export type OpenAiChatTextMessage = Readonly<{ role: 'developer' | 'system' | 'user' | 'assistant'; content: string }>;
export type OpenAiChatTextRequest = Readonly<{ model: string; messages: readonly OpenAiChatTextMessage[];
  max_completion_tokens: number; stream?: false; n?: 1 }>;
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
const definitionSchema = z.object({ endpoint: z.string().min(1), maxOutputTokens: positive,
  authentication: z.discriminatedUnion('type', [z.object({ type: z.literal('none') }).strict(),
    z.object({ type: z.literal('bearer'), credentialRef: credentialReference }).strict()]),
  tls: z.object({ caPem: certificate }).strict().optional() }).strict();
const limitsSchema = z.object({ requestMaxBytes: positive, responseMaxBytes: positive,
  timeoutMs: positive.max(2_147_483_647) }).strict();
const requestSchema = z.object({ model: z.string().min(1).max(1024), messages: z.array(z.object({
  role: z.enum(['developer', 'system', 'user', 'assistant']), content: z.string().min(1),
}).strict()).min(1).max(100_000), max_completion_tokens: positive, stream: z.literal(false).optional(),
  n: z.literal(1).optional() }).strict();
export const openAiChatWireObjectSchema = createImmutableJsonObjectSchema(OPENAI_CHAT_WIRE_LIMITS);

export function parseOpenAiChatHttpDefinition(input: unknown): OpenAiChatHttpDefinition {
  const copied = openAiChatWireObjectSchema.safeParse(input), parsed = copied.success && definitionSchema.safeParse(copied.data);
  if (!parsed || !parsed.success || !isCanonicalEndpoint(parsed.data.endpoint, parsed.data.authentication.type, parsed.data.tls !== undefined)) {
    throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  }
  const authentication = Object.freeze({ ...parsed.data.authentication });
  return Object.freeze({ endpoint: parsed.data.endpoint, maxOutputTokens: parsed.data.maxOutputTokens, authentication,
    ...(parsed.data.tls ? { tls: Object.freeze({ ...parsed.data.tls }) } : {}) });
}

export function parseOpenAiChatHttpLimits(input: unknown): OpenAiChatHttpLimits {
  const copied = openAiChatWireObjectSchema.safeParse(input), parsed = copied.success && limitsSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  return Object.freeze(parsed.data);
}

export function parseOpenAiChatTextRequest(input: unknown, definition: OpenAiChatHttpDefinition): OpenAiChatTextRequest {
  const copied = openAiChatWireObjectSchema.safeParse(input), parsed = copied.success && requestSchema.safeParse(copied.data);
  if (!parsed || !parsed.success || parsed.data.max_completion_tokens > definition.maxOutputTokens) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  return Object.freeze({ model: parsed.data.model, messages: Object.freeze(parsed.data.messages.map(message => Object.freeze({ ...message }))),
    max_completion_tokens: parsed.data.max_completion_tokens, ...(parsed.data.stream === false ? { stream: false as const } : {}),
    ...(parsed.data.n === 1 ? { n: 1 as const } : {}) });
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
