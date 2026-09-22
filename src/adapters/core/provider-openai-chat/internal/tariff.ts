import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { modelInvocationProfileSchema, parseModelBindingDefinition, parseProviderSpendQuote, type ProviderSpendQuote } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, OPERATOR_TARIFF_PRICING_ID, providerSpendEvidenceDigest,
  type ModelInvocationSpendingInput } from '#engine/index.js';
import { OPENAI_CHAT_HTTP_ADAPTER_ID, OPENAI_CHAT_HTTP_ADAPTER_VERSION, OpenAiChatHttpError, parseOpenAiChatHttpDefinition,
  parseOpenAiChatTextRequest } from './contract.js';
import { prepareOpenAiChatHttpRequest } from './transport.js';

export const OPENAI_CHAT_OPERATOR_TARIFF_METER_ID = 'openai-chat-operator-reservation' as const;

/**
 * Pure, repeatable quote from the operator-declared tariff in the profile. v1 tariffs are zero-rate, so the
 * verified maximum is zero; it is still reserved against the scope budget and settled in the spend ledger.
 */
export function quoteOpenAiChatOperatorTariff(input: ModelInvocationSpendingInput): ProviderSpendQuote {
  const profile = modelInvocationProfileSchema.parse(input.profile);
  if (profile.adapter.id !== OPENAI_CHAT_HTTP_ADAPTER_ID || profile.adapter.version !== OPENAI_CHAT_HTTP_ADAPTER_VERSION) {
    throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
  }
  const definition = parseOpenAiChatHttpDefinition(profile.adapter.definition), binding = parseModelBindingDefinition(input.definition);
  const request = parseOpenAiChatTextRequest(input.command.nativeRequest, definition);
  if (request.model !== binding.model.nativeId || !isDeepStrictEqual(input.command.reference, profile.reference)
    || input.command.expectedBinding.digest !== profile.bindingDigest || input.command.scopeId !== profile.scopeId
    || modelInvocationRequestDigest(input.command) !== input.requestDigest || modelInvocationProfileDigest(profile) !== input.profileDigest) {
    throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  }
  const tariff = definition.tariff, tariffDigest = providerSpendEvidenceDigest(tariff);
  const body = prepareOpenAiChatHttpRequest(definition, profile.limits, request).body;
  const evidence = { schemaVersion: 1, tariffDigest, bodyDigest: createHash('sha256').update(body).digest('hex'),
    calculation: { schemaVersion: 1, currency: tariff.currency, inputMinorUnitsPerMillionTokens: tariff.inputMinorUnitsPerMillionTokens,
      outputMinorUnitsPerMillionTokens: tariff.outputMinorUnitsPerMillionTokens, outputBound: request.max_completion_tokens, requestCount: 1 } };
  return parseProviderSpendQuote({ schemaVersion: 1, scopeId: input.command.scopeId, requestDigest: input.requestDigest,
    profileDigest: input.profileDigest, pricing: { id: OPERATOR_TARIFF_PRICING_ID, version: 1, digest: tariffDigest, definition: tariff },
    meter: { id: OPENAI_CHAT_OPERATOR_TARIFF_METER_ID, version: 1, evidenceDigest: providerSpendEvidenceDigest(evidence), evidence },
    currency: tariff.currency, maxChargeMinorUnits: 0 });
}
