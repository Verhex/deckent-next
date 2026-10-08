import { anthropicUsageSchema } from './assemble.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { modelInvocationProfileSchema, parseModelBindingDefinition, parseProviderSpendQuote, type ProviderSpendQuote } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, providerSpendEvidenceDigest, ProviderSpendError, measuredTariffExactMinorUnits, ceilProviderSpendExactMinorUnits, type ModelInvocationSpendingInput } from '#engine/index.js';
import { openAiChatUsageSchema, OpenAiChatHttpError, parseOpenAiChatTextRequest } from '#adapters/core/provider-openai-chat/index.js';
import { ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID, ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION, ANTHROPIC_MESSAGES_METER_ID, ANTHROPIC_MESSAGES_PRICING_ID,
  ANTHROPIC_PROMPT_OVERHEAD_TOKENS, parseAnthropicMessagesDefinition, type AnthropicPublishedTariff, type AnthropicTariffRates } from './contract.js';

/** Rates as integers of 0.0001 USD per million tokens, so the bound is exact bigint arithmetic (no floating point). */
const units = (decimal: string): bigint => {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
};
/**
 * The rate set a prompt of `promptTokens` tokens pays: the last prompt-length tier whose threshold it exceeds, else the base rates (a flat
 * v1 tariff has only those). An unknown size (null) pays the last tier, the dearest one (the schema orders tiers by threshold and rate).
 * The same rule prices a reservation (a proven upper bound of the prompt) and a settlement (the provider-reported prompt).
 */
export function anthropicTariffRates(tariff: AnthropicPublishedTariff, promptTokens: number | null): Readonly<{ rates: AnthropicTariffRates; aboveTokens: number | null }> {
  let selected: Readonly<{ rates: AnthropicTariffRates; aboveTokens: number | null }> = { rates: tariff.usdPerMTok, aboveTokens: null };
  if (tariff.version === 1) return selected;
  for (const tier of tariff.promptTiers) if (promptTokens === null || promptTokens > tier.aboveTokens) selected = { rates: tier.usdPerMTok, aboveTokens: tier.aboveTokens };
  return selected;
}
/** Prompt size as the provider reports it on a response: uncached input plus cache writes plus cache reads; null when input is unreported. */
export function anthropicReportedPromptTokens(usage: Readonly<{ input_tokens: number | null; cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null }>): number | null {
  return usage.input_tokens === null ? null : usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}
/**
 * Verified worst case of one call in minor units (cents): every prompt byte counts as a token (a token is never shorter than a
 * byte) plus the tool-use overhead, at the dearest input class in effect (a cache write when caching is on), plus every allowed
 * output token (thinking is billed as output and counts inside `max_tokens`). Ceil once, at the end. A tiered tariff is priced at the
 * tier of that same prompt bound: the real prompt can only be smaller, so the reservation never falls into a cheaper tier than the call.
 */
export function anthropicMaxChargeMinorUnits(tariff: AnthropicPublishedTariff, cache: 'none' | '5m' | '1h', bodyBytes: number, maxTokens: number): number {
  const rates = anthropicTariffRates(tariff, bodyBytes + ANTHROPIC_PROMPT_OVERHEAD_TOKENS).rates;
  let input = units(rates.input);
  if (cache === '5m' && units(rates.cacheWrite5m) > input) input = units(rates.cacheWrite5m);
  if (cache === '1h' && units(rates.cacheWrite1h) > input) input = units(rates.cacheWrite1h);
  const numerator = BigInt(bodyBytes + ANTHROPIC_PROMPT_OVERHEAD_TOKENS) * input + BigInt(maxTokens) * units(rates.output);
  // tokens x (rate/1e4 USD per 1e6 tokens) = USD x 1e10; minor units = USD x 100.
  const minor = (numerator + 99_999_999n) / 100_000_000n;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  return Number(minor);
}

export type AnthropicPreparedView = Readonly<{ body: string; request: { max_completion_tokens: number; model: string }; scopeId: string;
  definition: unknown; limits: unknown }>;

/** Pure, repeatable quote for the exact prepared request: published tariff from the profile, real reservation bound. */
export function quoteAnthropicPublishedTariff(input: ModelInvocationSpendingInput, prepared: AnthropicPreparedView): ProviderSpendQuote {
  const profile = modelInvocationProfileSchema.parse(input.profile);
  if (profile.adapter.id !== ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID || profile.adapter.version !== ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION) throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  const definition = parseAnthropicMessagesDefinition(profile.adapter.definition), binding = parseModelBindingDefinition(input.definition);
  const request = parseOpenAiChatTextRequest(input.command.nativeRequest, definition);
  if (request.model !== binding.model.nativeId || request.model !== definition.tariff.modelId || prepared.request.model !== request.model
    || prepared.request.max_completion_tokens !== request.max_completion_tokens || prepared.scopeId !== profile.scopeId
    // The token must come from this very profile (endpoint, key reference, tariff, thinking and cache choices, limits), not a sibling one.
    || !isDeepStrictEqual(prepared.definition, definition) || !isDeepStrictEqual(prepared.limits, profile.limits)
    || !isDeepStrictEqual(input.command.reference, profile.reference) || input.command.expectedBinding.digest !== profile.bindingDigest
    || input.command.scopeId !== profile.scopeId || modelInvocationRequestDigest(input.command) !== input.requestDigest
    || modelInvocationProfileDigest(profile) !== input.profileDigest) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  const tariff = definition.tariff, tariffDigest = providerSpendEvidenceDigest(tariff), cache = definition.cache ?? 'none';
  const bodyBytes = Buffer.byteLength(prepared.body, 'utf8');
  const maxChargeMinorUnits = anthropicMaxChargeMinorUnits(tariff, cache, bodyBytes, request.max_completion_tokens);
  const inputBoundTokens = bodyBytes + ANTHROPIC_PROMPT_OVERHEAD_TOKENS;
  // A tiered tariff records which prompt-length tier the bound selected (null = base rates); a flat quote keeps its v1 evidence bytes.
  const promptTier = tariff.version === 1 ? {} : { promptTier: { basis: tariff.promptTokenBasis, aboveTokens: anthropicTariffRates(tariff, inputBoundTokens).aboveTokens } };
  const evidence = { schemaVersion: 1, tariffDigest, bodyDigest: createHash('sha256').update(prepared.body).digest('hex'),
    calculation: { schemaVersion: 1, currency: tariff.currency, minorUnitsPerCurrencyUnit: 100, rounding: 'ceil-total', cache,
      inputBound: 'body-bytes-as-tokens-plus-overhead', inputBoundTokens, ...promptTier,
      outputBound: 'requested-max-tokens', outputBoundTokens: request.max_completion_tokens, requestCount: 1 } };
  return parseProviderSpendQuote({ schemaVersion: 1, scopeId: input.command.scopeId, requestDigest: input.requestDigest, profileDigest: input.profileDigest,
    pricing: { id: ANTHROPIC_MESSAGES_PRICING_ID, version: tariff.version, digest: tariffDigest, definition: tariff },
    meter: { id: ANTHROPIC_MESSAGES_METER_ID, version: 1, evidenceDigest: providerSpendEvidenceDigest(evidence), evidence },
    currency: tariff.currency, maxChargeMinorUnits });
}

/** Reported cache dimensions are disjoint. A missing split pays the dearest write rate. */
export function anthropicSettledCharge(tariff: AnthropicPublishedTariff, input: unknown) {
  const usage = openAiChatUsageSchema.safeParse(input);
  if (!usage.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const fields = anthropicUsageSchema.parse(usage.data['anthropic']);
  if (fields.input_tokens == null) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const total = anthropicReportedPromptTokens({ input_tokens: fields.input_tokens, cache_creation_input_tokens: fields.cache_creation_input_tokens ?? 0, cache_read_input_tokens: fields.cache_read_input_tokens ?? 0 });
  const selected = anthropicTariffRates(tariff, total), rates = selected.rates;
  const write = fields.cache_creation_input_tokens ?? 0, read = fields.cache_read_input_tokens ?? 0;
  if (total !== usage.data.prompt_tokens || (fields.cache_creation
    && BigInt(fields.cache_creation.ephemeral_5m_input_tokens) + BigInt(fields.cache_creation.ephemeral_1h_input_tokens) !== BigInt(write))) {
    throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  }
  const dimensions = [
    { field: 'input', tokens: fields.input_tokens, usdPerMillionTokens: rates.input },
    { field: 'cache-read', tokens: read, usdPerMillionTokens: rates.cacheRead },
    { field: 'cache-write-5m', tokens: fields.cache_creation?.ephemeral_5m_input_tokens ?? 0, usdPerMillionTokens: rates.cacheWrite5m },
    { field: !fields.cache_creation && write > 0 ? 'cache-write-unsplit' : 'cache-write-1h', tokens: fields.cache_creation?.ephemeral_1h_input_tokens ?? (write > 0 ? write : 0),
      usdPerMillionTokens: fields.cache_creation ? rates.cacheWrite1h : units(rates.cacheWrite5m) > units(rates.cacheWrite1h) ? rates.cacheWrite5m : rates.cacheWrite1h },
    { field: 'output', tokens: usage.data.completion_tokens, usdPerMillionTokens: rates.output },
  ];
  const exactMinorUnits = measuredTariffExactMinorUnits(dimensions);
  return { exactMinorUnits, roundedMinorUnits: ceilProviderSpendExactMinorUnits(exactMinorUnits),
    tier: selected.aboveTokens, dimensions, cacheSplit: fields.cache_creation ? 'reported' as const : write > 0 ? 'dearest' as const : 'none' as const };
}
