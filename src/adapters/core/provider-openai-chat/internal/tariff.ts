import { verifiedOpenAiCompatibleTariff } from './pricing-catalog.js';
import { isLiteralLoopbackHostname } from '#platform/index.js';
import { openAiChatPromptUpperBound } from './invocation.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { modelInvocationProfileSchema, parseModelBindingDefinition, parseProviderSpendQuote, type ProviderSpendQuote } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, OPERATOR_TARIFF_PRICING_ID, providerSpendEvidenceDigest,
  ProviderSpendError, measuredTariffExactMinorUnits, ceilProviderSpendExactMinorUnits, providerSpendExactFromNumericSource, compareProviderSpendExactMinorUnits, type ModelInvocationSpendingInput } from '#engine/index.js';
import { isOpenAiChatHttpAdapter, OpenAiChatHttpError, parseOpenAiChatHttpDefinition,
  parseOpenAiChatTextRequest } from './contract.js';
import { prepareOpenAiChatHttpRequest } from './transport.js';

export const OPENAI_CHAT_OPERATOR_TARIFF_METER_ID = 'openai-chat-operator-reservation' as const;

/**
 * Pure maximum quote from a verified published tariff or an explicit operator tariff.
 * The input bound uses the dearest input rate; loopback legacy zero tariffs remain supported.
 */
export function quoteOpenAiChatOperatorTariff(input: ModelInvocationSpendingInput, preparedBody?: string, reasoningInputTokensUpperBound = 0): ProviderSpendQuote {
  if (!Number.isSafeInteger(reasoningInputTokensUpperBound) || reasoningInputTokensUpperBound < 0) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  const profile = modelInvocationProfileSchema.parse(input.profile);
  if (!isOpenAiChatHttpAdapter(profile.adapter)) {
    throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  }
  const definition = parseOpenAiChatHttpDefinition(profile.adapter.definition), binding = parseModelBindingDefinition(input.definition);
  const request = parseOpenAiChatTextRequest(input.command.nativeRequest, definition);
  if (request.model !== binding.model.nativeId || !isDeepStrictEqual(input.command.reference, profile.reference)
    || input.command.expectedBinding.digest !== profile.bindingDigest || input.command.scopeId !== profile.scopeId
    || modelInvocationRequestDigest(input.command) !== input.requestDigest || modelInvocationProfileDigest(profile) !== input.profileDigest) {
    throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  }
  const tariff = definition.tariff;
  const rates = openAiCompatibleTariffRates(tariff, definition.endpoint, request.model);
  const tariffDigest = providerSpendEvidenceDigest(tariff);
  const body = preparedBody ?? prepareOpenAiChatHttpRequest(definition, profile.limits, request).body;
  // Opaque reasoning replay expands the actual wire prompt; the reservation must bound what is sent, not only the neutral messages.
  const inputBound = definition.dialect?.protocol === 'responses'
    ? Math.max(openAiChatPromptUpperBound(input.command.nativeRequest), Buffer.byteLength(body, 'utf8')) + reasoningInputTokensUpperBound : openAiChatPromptUpperBound(input.command.nativeRequest);
  if (!Number.isSafeInteger(inputBound)) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_TOO_LARGE');
  const evidence = { schemaVersion: 1, tariffDigest, bodyDigest: createHash('sha256').update(body).digest('hex'),
    calculation: { schemaVersion: 1, currency: tariff.currency, usdPerMTok: rates, inputBound, outputBound: request.max_completion_tokens, requestCount: 1,
      ...(definition.dialect?.protocol === 'responses' ? { reasoningInputTokensUpperBound } : {}) } };
  return parseProviderSpendQuote({ schemaVersion: 1, scopeId: input.command.scopeId, requestDigest: input.requestDigest,
    profileDigest: input.profileDigest, pricing: { id: tariff.kind === 'operator-static' ? OPERATOR_TARIFF_PRICING_ID : 'openai-compatible-published-tariff', version: tariff.version, digest: tariffDigest, definition: tariff },
    meter: { id: OPENAI_CHAT_OPERATOR_TARIFF_METER_ID, version: 1, evidenceDigest: providerSpendEvidenceDigest(evidence), evidence },
    currency: tariff.currency, maxChargeMinorUnits: ceilProviderSpendExactMinorUnits(measuredTariffExactMinorUnits([
      { field: 'input', tokens: inputBound, usdPerMillionTokens: [rates.input, rates.cachedInput, 'cacheWrite' in rates ? rates.cacheWrite! : rates.input].reduce((a, b) => compareProviderSpendExactMinorUnits(a, b) >= 0 ? a : b) },
      { field: 'output', tokens: request.max_completion_tokens, usdPerMillionTokens: rates.output }])) });
}

/** A zero-rate legacy tariff is admitted only for a loopback endpoint. Remote paid calls require verified or explicitly declared rates. */
export function openAiCompatibleTariffRates(tariff: ReturnType<typeof parseOpenAiChatHttpDefinition>['tariff'], endpoint: string, modelId: string) {
  // Metadata-priced OpenRouter calls have a separate priced wrapper; they never reach a static/zero tariff.
  if (tariff.kind === 'openrouter-endpoint') throw new ProviderSpendError('PROVIDER_SPEND_TARIFF_UNVERIFIED');
  if (tariff.kind === 'vendor-published') {
    if (!verifiedOpenAiCompatibleTariff(tariff, endpoint, modelId)) throw new ProviderSpendError('PROVIDER_SPEND_TARIFF_UNVERIFIED');
    if (tariff.version === 1) return tariff.usdPerMTok;
    // Auto project processing can select Fast. Bound each class over every published applicable Chat tier/context.
    const tiers = tariff.processingTiers.flatMap(tier => [tier.usdPerMTok, tier.longContextUsdPerMTok]);
    const maximum = (field: 'input' | 'cachedInput' | 'cacheWrite' | 'output') => tiers.map(tier => providerSpendExactFromNumericSource(tier[field], 1))
      .reduce((a, b) => compareProviderSpendExactMinorUnits(a, b) >= 0 ? a : b);
    return { input: maximum('input'), cachedInput: maximum('cachedInput'), cacheWrite: maximum('cacheWrite'), output: maximum('output') };
  }
  const loopback = isLiteralLoopbackHostname(new URL(endpoint).hostname);
  if (!loopback && tariff.version !== 2) throw new ProviderSpendError('PROVIDER_SPEND_TARIFF_UNVERIFIED');
  return { input: providerSpendExactFromNumericSource(`${tariff.inputMinorUnitsPerMillionTokens}e-2`, 1),
    cachedInput: providerSpendExactFromNumericSource(`${tariff.cachedInputMinorUnitsPerMillionTokens ?? tariff.inputMinorUnitsPerMillionTokens}e-2`, 1),
    output: providerSpendExactFromNumericSource(`${tariff.outputMinorUnitsPerMillionTokens}e-2`, 1) };
}
