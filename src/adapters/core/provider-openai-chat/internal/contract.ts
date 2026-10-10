import { openAiChatDialectSchema, type OpenAiChatDialect } from '#domain/index.js';
export { openAiChatDialectSchema, OPENAI_CHAT_DEFAULT_DIALECT, type OpenAiChatDialect } from '#domain/index.js';
import { nativeJsonHttpCertificateSchema as certificate } from '#adapters/core/provider-http-json/index.js';
import { parseOpenAiChatProtocolRequest, openAiChatWireObjectSchema as protocolWireObjectSchema, type OpenAiChatTextRequest as ProtocolTextRequest } from '#domain/index.js';
export const openAiChatWireObjectSchema = protocolWireObjectSchema;
export { openAiChatUsageSchema, parseOpenAiChatHttpLimits, type OpenAiChatHttpLimits } from '#domain/index.js';
import { OpenAiChatHttpError as ProtocolHttpError } from '#domain/index.js';
export const OpenAiChatHttpError = ProtocolHttpError;
export type OpenAiChatHttpError = InstanceType<typeof ProtocolHttpError>;
export { OPENAI_CHAT_TOOL_NAME, OPENAI_CHAT_MAX_TOOLS, OPENAI_CHAT_MAX_TOOL_CALLS, type OpenAiChatHttpErrorCode, type OpenAiReasoningEffort, type OpenAiChatToolCall, type OpenAiChatTextMessage, type OpenAiChatToolDefinition } from '#domain/index.js';
import { openAiCompatiblePublishedTariffSchema, type OpenAiCompatiblePublishedTariff } from './pricing-catalog.js';
import { z } from 'zod';
import { wellFormedModelJson, type JsonObject } from '#domain/index.js';

export const OPENAI_CHAT_HTTP_ADAPTER_ID = 'openai-chat-http' as const;
/** v5 (T4-B K1, owner 2026-10-08, Jev d69089cf): the definition carries the provider's request dialect (`dialect`, required); v4 profiles keep
 * working unchanged (no dialect: the OpenAI wire). Model routes may select v6 Responses; other new connections write v5. */
export const OPENAI_CHAT_HTTP_ADAPTER_VERSION = 5 as const;
export const OPENAI_RESPONSES_HTTP_ADAPTER_VERSION = 6 as const;
export const OPENAI_CHAT_HTTP_ADAPTER_VERSIONS = Object.freeze([4, 5, 6] as const);
/** Whether an adapter identity is one this adapter serves (v4/v5 chat or v6 Responses). */
export function isOpenAiChatHttpAdapter(adapter: Readonly<{ id: string; version: number }>): boolean {
  return adapter.id === OPENAI_CHAT_HTTP_ADAPTER_ID && (OPENAI_CHAT_HTTP_ADAPTER_VERSIONS as readonly number[]).includes(adapter.version);
}
export const OPENAI_CHAT_COMPLETIONS_FAMILY = 'openai-chat-completions' as const;
export const OPENAI_CHAT_COMPLETIONS_VERSION = 'v1' as const;
export { MODEL_INVOCATION_NATIVE_JSON_LIMITS as OPENAI_CHAT_WIRE_LIMITS } from '#domain/index.js';

export type OpenAiChatHttpAuthentication = Readonly<{ type: 'none' } | { type: 'bearer'; credentialRef: string }>;
/** Operator-declared tariff for servers without a provider price feed. v1: zero rates only (free/local models); v2 (SPEND-SETTLEMENT):
 * non-zero USD cents/MTok, fractional cents as exact decimal strings. */
export type OpenAiChatOperatorTariff = Readonly<{ kind: 'operator-static'; version: 1 | 2; currency: string;
  inputMinorUnitsPerMillionTokens: number | string; outputMinorUnitsPerMillionTokens: number | string; cachedInputMinorUnitsPerMillionTokens?: number | string }>;
export const openRouterEndpointTariffSchema = z.object({ kind: z.literal('openrouter-endpoint'), version: z.literal(1), currency: z.literal('USD'),
  metadataEndpoint: z.string().url(), endpointTag: z.string().min(1).max(1024),
  metadataLimits: z.object({ maxAgeMs: z.number().int().positive().safe(), maxResponseBytes: z.number().int().positive().safe(),
    timeoutMs: z.number().int().positive().safe() }).strict() }).strict();
export type OpenRouterEndpointTariff = z.infer<typeof openRouterEndpointTariffSchema>;
export type OpenAiChatHttpDefinition = Readonly<{ endpoint: string; maxOutputTokens: number; dialect?: OpenAiChatDialect;
  authentication: OpenAiChatHttpAuthentication; tls?: Readonly<{ caPem: string }>; tariff: OpenAiChatOperatorTariff | OpenAiCompatiblePublishedTariff | OpenRouterEndpointTariff;
  /** vLLM-style `POST /tokenize` of the same origin (T-L5); used only when the binding declares `token-count`. */
  tokenizeEndpoint?: string }>;
export type OpenAiChatHttpResponse = Readonly<{ schemaVersion: 1; native: JsonObject; usage: JsonObject | null }>;

const positive = z.number().int().positive().safe();
const credentialReference = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
// Whole cents stay numeric; fractional cents are decimal strings, never binary floating point.
const operatorRate = positive.or(z.literal(0)).or(z.string().max(32).regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/));
const tariffSchema = z.union([z.object({ kind: z.literal('operator-static'), version: z.literal(1), currency: z.string().regex(/^[A-Z]{3}$/),
  inputMinorUnitsPerMillionTokens: z.literal(0), outputMinorUnitsPerMillionTokens: z.literal(0) }).strict(),
  z.object({ kind: z.literal('operator-static'), version: z.literal(2), currency: z.literal('USD'),
    inputMinorUnitsPerMillionTokens: operatorRate, outputMinorUnitsPerMillionTokens: operatorRate,
    cachedInputMinorUnitsPerMillionTokens: operatorRate }).strict(), openAiCompatiblePublishedTariffSchema, openRouterEndpointTariffSchema]);
const definitionSchema = z.object({ endpoint: z.string().min(1), maxOutputTokens: positive, dialect: openAiChatDialectSchema.optional(),
  authentication: z.discriminatedUnion('type', [z.object({ type: z.literal('none') }).strict(),
    z.object({ type: z.literal('bearer'), credentialRef: credentialReference }).strict()]),
  tls: z.object({ caPem: certificate }).strict().optional(), tariff: tariffSchema, tokenizeEndpoint: z.string().min(1).optional() }).strict();

export const openAiChatFinishReasonSchema = z.enum(['stop', 'length', 'content_filter', 'tool_calls']);
export function parseOpenAiChatHttpDefinition(input: unknown): OpenAiChatHttpDefinition {
  const copied = openAiChatWireObjectSchema.safeParse(input), parsed = copied.success && definitionSchema.safeParse(copied.data);
  if (!parsed || !parsed.success || !isCanonicalEndpoint(parsed.data.endpoint, parsed.data.authentication.type, parsed.data.tls !== undefined)) {
    throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  }
  // The counter sees the same prompt as the round: it must be the same origin (scheme, host, port), so egress is identical.
  const tokenize = parsed.data.tokenizeEndpoint;
  if (tokenize !== undefined && (!isCanonicalEndpoint(tokenize, parsed.data.authentication.type, parsed.data.tls !== undefined)
    || new URL(tokenize).origin !== new URL(parsed.data.endpoint).origin)) throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  if (parsed.data.tariff.kind === 'openrouter-endpoint') {
    const source = new URL(parsed.data.tariff.metadataEndpoint), endpoint = new URL(parsed.data.endpoint);
    if (source.protocol !== 'https:' || source.origin !== endpoint.origin || source.username || source.password || source.search || source.hash
      || source.href !== parsed.data.tariff.metadataEndpoint || !parsed.data.dialect) throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  }
  const authentication = Object.freeze({ ...parsed.data.authentication });
  const dialect = parsed.data.dialect;
  return Object.freeze({ endpoint: parsed.data.endpoint, maxOutputTokens: parsed.data.maxOutputTokens, authentication,
    ...(dialect ? { dialect: Object.freeze({ ...dialect, toolChoice: Object.freeze([...dialect.toolChoice]) }) } : {}),
    ...(parsed.data.tls ? { tls: Object.freeze({ ...parsed.data.tls }) } : {}), tariff: Object.freeze({ ...parsed.data.tariff }),
    ...(tokenize !== undefined ? { tokenizeEndpoint: tokenize } : {}) });
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

export function parseOpenAiChatTextRequest(input: unknown, definition: Pick<OpenAiChatHttpDefinition, 'maxOutputTokens'>): OpenAiChatTextRequest {
  return parseOpenAiChatProtocolRequest(input, definition, wellFormedModelJson);
}
export { OPENAI_CHAT_TOOL_CALLS_CAPABILITY, OPENAI_CHAT_TOKEN_COUNT_CAPABILITY, OPENAI_CHAT_ENABLE_THINKING_CAPABILITY, OPENAI_CHAT_PREFIX_CACHE_SALT_CAPABILITY } from '#domain/index.js';
export type OpenAiChatTextRequest = ProtocolTextRequest;
