import { persistedString, persistedInteger, persistedUrl, catalogTariffSealSchema, createImmutableJsonObjectSchema, MODEL_INVOCATION_NATIVE_JSON_LIMITS } from '#domain/index.js';
import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { OpenAiChatHttpError, parseOpenAiChatHttpLimits } from '#adapters/core/provider-openai-chat/index.js';
import { ANTHROPIC_EFFORT_LEVELS, ANTHROPIC_METERING, anthropicControlsAdmitted } from './model-capabilities.js';
export const ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID = 'anthropic-messages-http' as const;
/** v2 (2026-09-29): profile `effort`, and thinking/effort/max-output checked against the model capability registry at load. */
export const ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION = 2 as const;
export const ANTHROPIC_MESSAGES_FAMILY = 'anthropic-messages' as const;
/** The Messages API pins its wire contract with this header value (still the only current one, 2026-09-28). */
export const ANTHROPIC_MESSAGES_PROTOCOL_VERSION = '2023-06-01' as const;
export const ANTHROPIC_MESSAGES_PRICING_ID = 'anthropic-published-tariff' as const;
export const ANTHROPIC_MESSAGES_METER_ID = 'anthropic-messages-reservation' as const;
export const anthropicMessagesProtocol = Object.freeze({ family: ANTHROPIC_MESSAGES_FAMILY, version: ANTHROPIC_MESSAGES_PROTOCOL_VERSION });
const ANTHROPIC_MESSAGES_WIRE_LIMITS = MODEL_INVOCATION_NATIVE_JSON_LIMITS;
/** Versioned local reservation allowance added to the byte-based prompt bound (not an exact vendor count). */
export const ANTHROPIC_PROMPT_OVERHEAD_TOKENS = ANTHROPIC_METERING.promptOverheadTokens;
const rate = z.string().regex(/^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/);
const ratesSchema = z.strictObject({ input: rate, cacheWrite5m: rate, cacheWrite1h: rate, cacheRead: rate, output: rate });
// Key order is the v1 order (kind, version, currency, modelId, usdPerMTok, source): parsed tariffs keep their serialized bytes and digests.
const tariffFields = <V extends 1 | 2>(version: V) => ({ kind: z.literal('anthropic-published'), version: z.literal(version), currency: z.literal('USD'),
  modelId: persistedString(z.string().min(1).max(256)), usdPerMTok: ratesSchema,
  // M4: `catalog` seals the registered catalog row `models connect` took the tariff from (absent on shipped `pricing.json` rows).
  source: z.strictObject({ get url() { return persistedUrl().startsWith('https://'); }, get retrievedAt() { return z.string().regex(/^\d{4}-\d{2}-\d{2}$/); },
    get catalog() { return catalogTariffSealSchema.optional(); } }) });
export type AnthropicTariffRates = z.infer<typeof ratesSchema>;
/** A later tier never costs less in any class, so the last tier is the dearest (the price of an unknown prompt size). */
const notCheaper = (before: AnthropicTariffRates, after: AnthropicTariffRates) =>
  (Object.keys(before) as (keyof AnthropicTariffRates)[]).every(key => Number(after[key]) >= Number(before[key]));
/**
 * Published USD per million tokens as decimal strings (at most 4 fraction digits), dated and sourced: adapter-owned pricing data.
 * v1 is one flat rate set (shape unchanged, so stored profiles and their digests stay valid). v2 (2026-10-08) adds prompt-length tiers:
 * `usdPerMTok` applies up to the first threshold and each tier to prompts of more than `aboveTokens` tokens counted as `promptTokenBasis`.
 */
export const anthropicTariffSchema = z.union([
  z.strictObject(tariffFields(1)),
  z.strictObject({ ...tariffFields(2), get promptTokenBasis() { return z.literal('input+cache-write+cache-read'); },
    get promptTiers() { return z.array(z.strictObject({ aboveTokens: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), usdPerMTok: ratesSchema })).min(1); } })
    .refine(tariff => tariff.promptTiers.every((tier, index) => {
      const previous = index === 0 ? null : tariff.promptTiers[index - 1]!;
      return (previous === null || previous.aboveTokens < tier.aboveTokens) && notCheaper(previous?.usdPerMTok ?? tariff.usdPerMTok, tier.usdPerMTok);
    })),
]);
export type AnthropicPublishedTariff = z.infer<typeof anthropicTariffSchema>;
const thinkingSchema = z.discriminatedUnion('mode', [
  z.strictObject({ get mode() { return z.literal('model-default'); }, get off() { return z.enum(['disabled', 'between_tools']).optional(); } }),
  z.strictObject({ get mode() { return z.literal('adaptive'); }, get display() { return z.enum(['summarized', 'omitted']); }, get off() { return z.enum(['disabled', 'between_tools']).optional(); } }),
  z.strictObject({ get mode() { return z.literal('enabled'); }, get budgetTokens() { return persistedInteger().min(ANTHROPIC_METERING.thinkingBudgetMinTokens).min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER); }, get off() { return z.literal('disabled').optional(); } }),
]);
export type AnthropicThinking = z.infer<typeof thinkingSchema>;
const certificate = persistedString(z.string().min(1).max(65_536)).refine(value => {
  if ((value.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1
    || (value.match(/-----END CERTIFICATE-----/g) ?? []).length !== 1 || value.includes('PRIVATE KEY')) return false;
  try {
    const parsed = new X509Certificate(value), canonical = (text: string) => text.replace(/\r\n/g, '\n').trimEnd();
    return canonical(value) === canonical(parsed.toString());
  } catch { return false; }
});
const definitionSchema = z.strictObject({ get endpoint() { return persistedString(z.string().min(1)); }, get maxOutputTokens() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER); },
  get workspaceId() { return z.string().regex(/^wrkspc_[A-Za-z0-9]{1,120}$/u).optional(); },
  get authentication() { return z.strictObject({ type: z.literal('header'), name: z.literal('x-api-key'), credentialRef: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/) }); },
  get tls() { return z.strictObject({ caPem: certificate }).optional(); }, tariff: anthropicTariffSchema,
  /** Absent = the model's default thinking (Opus 5.5 / Fable 5.1 / Sonnet 5.5 / Haiku 5.5: adaptive, thinking text omitted). */
  get thinking() { return thinkingSchema.optional(); },
  /** `output_config.effort`; absent = the model's registry default (e.g. Opus 5.5 and Haiku 5.5: medium). Only levels the model's registry row lists. */
  get effort() { return z.enum(ANTHROPIC_EFFORT_LEVELS).optional(); }, get cache() { return z.enum(['none', '5m', '1h']).optional(); },
  get tokenCountEndpoint() { return persistedString(z.string().min(1)).optional(); } });
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
  // Only what the pinned model's documented request surface accepts (a 400 caught at load, not at call time).
  if (!anthropicControlsAdmitted(parsed.data.tariff.modelId, parsed.data)) throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  return Object.freeze(structuredClone(parsed.data));
}
export const parseAnthropicMessagesLimits = parseOpenAiChatHttpLimits;
