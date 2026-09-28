import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { modelInvocationProfileSchema, parseModelBindingDefinition, parseProviderSpendQuote, type ProviderSpendQuote } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, providerSpendEvidenceDigest, type ModelInvocationSpendingInput } from '#engine/index.js';
import { OpenAiChatHttpError, parseOpenAiChatTextRequest } from '#adapters/core/provider-openai-chat/index.js';
import { ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID, ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION, ANTHROPIC_MESSAGES_METER_ID, ANTHROPIC_MESSAGES_PRICING_ID,
  ANTHROPIC_PROMPT_OVERHEAD_TOKENS, parseAnthropicMessagesDefinition, type AnthropicPublishedTariff } from './contract.js';

/** Rates as integers of 0.0001 USD per million tokens, so the bound is exact bigint arithmetic (no floating point). */
const units = (decimal: string): bigint => {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
};
/**
 * Verified worst case of one call in minor units (cents): every prompt byte counts as a token (a token is never shorter than a
 * byte) plus the tool-use overhead, at the dearest input class in effect (a cache write when caching is on), plus every allowed
 * output token (thinking is billed as output and counts inside `max_tokens`). Ceil once, at the end.
 */
export function anthropicMaxChargeMinorUnits(tariff: AnthropicPublishedTariff, cache: 'none' | '5m' | '1h', bodyBytes: number, maxTokens: number): number {
  const rates = tariff.usdPerMTok;
  let input = units(rates.input);
  if (cache === '5m' && units(rates.cacheWrite5m) > input) input = units(rates.cacheWrite5m);
  if (cache === '1h' && units(rates.cacheWrite1h) > input) input = units(rates.cacheWrite1h);
  const numerator = BigInt(bodyBytes + ANTHROPIC_PROMPT_OVERHEAD_TOKENS) * input + BigInt(maxTokens) * units(rates.output);
  // tokens x (rate/1e4 USD per 1e6 tokens) = USD x 1e10; minor units = USD x 100.
  const minor = (numerator + 99_999_999n) / 100_000_000n;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  return Number(minor);
}

export type AnthropicPreparedView = Readonly<{ body: string; request: { max_completion_tokens: number; model: string }; scopeId: string }>;

/** Pure, repeatable quote for the exact prepared request: published tariff from the profile, real reservation bound. */
export function quoteAnthropicPublishedTariff(input: ModelInvocationSpendingInput, prepared: AnthropicPreparedView): ProviderSpendQuote {
  const profile = modelInvocationProfileSchema.parse(input.profile);
  if (profile.adapter.id !== ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID || profile.adapter.version !== ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION) throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  const definition = parseAnthropicMessagesDefinition(profile.adapter.definition), binding = parseModelBindingDefinition(input.definition);
  const request = parseOpenAiChatTextRequest(input.command.nativeRequest, definition);
  if (request.model !== binding.model.nativeId || request.model !== definition.tariff.modelId || prepared.request.model !== request.model
    || prepared.request.max_completion_tokens !== request.max_completion_tokens || prepared.scopeId !== profile.scopeId
    || !isDeepStrictEqual(input.command.reference, profile.reference) || input.command.expectedBinding.digest !== profile.bindingDigest
    || input.command.scopeId !== profile.scopeId || modelInvocationRequestDigest(input.command) !== input.requestDigest
    || modelInvocationProfileDigest(profile) !== input.profileDigest) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  const tariff = definition.tariff, tariffDigest = providerSpendEvidenceDigest(tariff), cache = definition.cache ?? 'none';
  const bodyBytes = Buffer.byteLength(prepared.body, 'utf8');
  const maxChargeMinorUnits = anthropicMaxChargeMinorUnits(tariff, cache, bodyBytes, request.max_completion_tokens);
  const evidence = { schemaVersion: 1, tariffDigest, bodyDigest: createHash('sha256').update(prepared.body).digest('hex'),
    calculation: { schemaVersion: 1, currency: tariff.currency, minorUnitsPerCurrencyUnit: 100, rounding: 'ceil-total', cache,
      inputBound: 'body-bytes-as-tokens-plus-overhead', inputBoundTokens: bodyBytes + ANTHROPIC_PROMPT_OVERHEAD_TOKENS,
      outputBound: 'requested-max-tokens', outputBoundTokens: request.max_completion_tokens, requestCount: 1 } };
  return parseProviderSpendQuote({ schemaVersion: 1, scopeId: input.command.scopeId, requestDigest: input.requestDigest, profileDigest: input.profileDigest,
    pricing: { id: ANTHROPIC_MESSAGES_PRICING_ID, version: 1, digest: tariffDigest, definition: tariff },
    meter: { id: ANTHROPIC_MESSAGES_METER_ID, version: 1, evidenceDigest: providerSpendEvidenceDigest(evidence), evidence },
    currency: tariff.currency, maxChargeMinorUnits });
}
