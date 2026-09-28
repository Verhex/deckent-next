import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { createImmutableJsonObjectSchema, MODEL_INVOCATION_NATIVE_JSON_LIMITS } from '#domain/index.js';
import { OpenAiChatHttpError, parseOpenAiChatHttpLimits } from '#adapters/core/provider-openai-chat/index.js';

export const ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID = 'anthropic-messages-http' as const;
export const ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION = 1 as const;
export const ANTHROPIC_MESSAGES_FAMILY = 'anthropic-messages' as const;
/** The Messages API pins its wire contract with this header value (still the only current one, 2026-09-28). */
export const ANTHROPIC_MESSAGES_PROTOCOL_VERSION = '2023-06-01' as const;
export const ANTHROPIC_MESSAGES_PRICING_ID = 'anthropic-published-tariff' as const;
export const ANTHROPIC_MESSAGES_METER_ID = 'anthropic-messages-reservation' as const;
export const anthropicMessagesProtocol = Object.freeze({ family: ANTHROPIC_MESSAGES_FAMILY, version: ANTHROPIC_MESSAGES_PROTOCOL_VERSION });
export const ANTHROPIC_MESSAGES_WIRE_LIMITS = MODEL_INVOCATION_NATIVE_JSON_LIMITS;
/** Fixed allowance for the provider's tool-use system prompt (documented 286-804 tokens) added to the byte-based prompt bound. */
export const ANTHROPIC_PROMPT_OVERHEAD_TOKENS = 2048;

const rate = z.string().regex(/^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/);
/** Published USD per million tokens as decimal strings (at most 4 fraction digits), dated and sourced: adapter-owned pricing data. */
export const anthropicTariffSchema = z.object({ kind: z.literal('anthropic-published'), version: z.literal(1), currency: z.literal('USD'),
  modelId: z.string().min(1).max(256),
  usdPerMTok: z.object({ input: rate, cacheWrite5m: rate, cacheWrite1h: rate, cacheRead: rate, output: rate }).strict(),
  source: z.object({ url: z.string().url().startsWith('https://'), retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict() }).strict();
export type AnthropicPublishedTariff = z.infer<typeof anthropicTariffSchema>;

const thinkingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('model-default'), off: z.enum(['disabled', 'between_tools']).optional() }).strict(),
  z.object({ mode: z.literal('adaptive'), display: z.enum(['summarized', 'omitted']), off: z.enum(['disabled', 'between_tools']).optional() }).strict(),
  z.object({ mode: z.literal('enabled'), budgetTokens: z.number().int().min(1024).safe(), off: z.literal('disabled').optional() }).strict(),
]);
export type AnthropicThinking = z.infer<typeof thinkingSchema>;
const certificate = z.string().min(1).max(65_536).refine(value => {
  if ((value.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1
    || (value.match(/-----END CERTIFICATE-----/g) ?? []).length !== 1 || value.includes('PRIVATE KEY')) return false;
  try {
    const parsed = new X509Certificate(value), canonical = (text: string) => text.replace(/\r\n/g, '\n').trimEnd();
    return canonical(value) === canonical(parsed.toString());
  } catch { return false; }
});
const definitionSchema = z.object({ endpoint: z.string().min(1), maxOutputTokens: z.number().int().positive().safe(),
  authentication: z.object({ type: z.literal('header'), name: z.literal('x-api-key'), credentialRef: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/) }).strict(),
  tls: z.object({ caPem: certificate }).strict().optional(), tariff: anthropicTariffSchema,
  /** Absent = the model's default thinking (Opus 5.5 / Fable 5.1 / Sonnet 5.5: adaptive, thinking text omitted). */
  thinking: thinkingSchema.optional(), cache: z.enum(['none', '5m', '1h']).optional(),
  tokenCountEndpoint: z.string().min(1).optional() }).strict();
export type AnthropicMessagesDefinition = Readonly<z.infer<typeof definitionSchema>>;
const jsonSchema = createImmutableJsonObjectSchema(ANTHROPIC_MESSAGES_WIRE_LIMITS);

/** Every credential-carrying call is https (the API key never crosses cleartext), canonical, without query, fragment or userinfo. */
function canonical(endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  return url.protocol === 'https:' && url.search === '' && url.hash === '' && url.username === '' && url.password === ''
    && !endpoint.includes('?') && !endpoint.includes('#') && url.href === endpoint;
}
export function parseAnthropicMessagesDefinition(input: unknown): AnthropicMessagesDefinition {
  const copied = jsonSchema.safeParse(input), parsed = copied.success && definitionSchema.safeParse(copied.data);
  if (!parsed || !parsed.success || !canonical(parsed.data.endpoint)) throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  const count = parsed.data.tokenCountEndpoint, thinking = parsed.data.thinking;
  // The counter sees the same prompt as the round: same origin, so egress and credential scope are identical.
  if (count !== undefined && (!canonical(count) || new URL(count).origin !== new URL(parsed.data.endpoint).origin)) throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  // Manual thinking spends inside max_tokens: its budget must leave room for an answer.
  if (thinking?.mode === 'enabled' && thinking.budgetTokens >= parsed.data.maxOutputTokens) throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  return Object.freeze(structuredClone(parsed.data));
}
export const parseAnthropicMessagesLimits = parseOpenAiChatHttpLimits;
