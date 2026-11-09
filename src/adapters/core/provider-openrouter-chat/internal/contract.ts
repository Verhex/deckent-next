import { CodedError } from '#platform/index.js';
import { persistedString, persistedInteger, createImmutableJsonObjectSchema, MODEL_INVOCATION_NATIVE_JSON_LIMITS } from '#domain/index.js';
import { z } from 'zod';
import { parseNativeJsonHttpDefinition } from '#adapters/core/provider-http-json/index.js';

export const OPENROUTER_CHAT_HTTP_ADAPTER_ID = 'openrouter-chat-http' as const;
export const OPENROUTER_CHAT_HTTP_ADAPTER_VERSION = 1 as const;
export const OPENROUTER_CHAT_PROTOCOL = Object.freeze({ family: 'openrouter-chat-completions', version: 'v1' });
export class OpenRouterChatError extends CodedError {
  constructor(override readonly code: 'INVALID_PROFILE' | 'INVALID_REQUEST' | 'REQUEST_TOO_LARGE' | 'TARIFF_CONFLICT') {
    super(code); this.name = 'OpenRouterChatError';
  }
}
export const openRouterChatJsonSchema = createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS);
const definitionSchema = z.strictObject({ endpoint: z.string(), authentication: z.unknown().optional(), tls: z.unknown().optional(),
  maxOutputTokens: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), metadataEndpoint: z.string(), endpointTag: persistedString(z.string().min(1)),
  metadataLimits: z.strictObject({ maxAgeMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    maxResponseBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).max(1_048_576),
    timeoutMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).max(2_147_483_647) }).readonly() });
export function parseOpenRouterChatDefinition(input: unknown) {
  const copied = openRouterChatJsonSchema.safeParse(input), parsed = copied.success && definitionSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) throw new OpenRouterChatError('INVALID_PROFILE');
  const value = parsed.data;
  let transport;
  try { transport = parseNativeJsonHttpDefinition({ endpoint: value.endpoint, authentication: value.authentication,
    ...(value.tls !== undefined ? { tls: value.tls } : {}) }); }
  catch { throw new OpenRouterChatError('INVALID_PROFILE'); }
  let source: URL;
  try { source = new URL(value.metadataEndpoint); } catch { throw new OpenRouterChatError('INVALID_PROFILE'); }
  if (source.protocol !== 'https:' || source.href !== value.metadataEndpoint || source.username || source.password
    || source.search || source.hash || source.origin !== new URL(transport.endpoint).origin) {
    throw new OpenRouterChatError('INVALID_PROFILE');
  }
  return Object.freeze({ transport, maxOutputTokens: value.maxOutputTokens, metadataEndpoint: source.href,
    endpointTag: value.endpointTag, metadataLimits: Object.freeze(value.metadataLimits) });
}
