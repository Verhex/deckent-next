import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { modelInvocationProfileSchema, parseModelBindingDefinition, parseProviderSpendQuote, type ProviderSpendQuote } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, OPERATOR_TARIFF_PRICING_ID, providerSpendEvidenceDigest, type ModelInvocationSpendingInput } from '#engine/index.js';
import { DecisionHttpError, decisionHttpAdapter, decisionHttpProtocolData } from './contract.js';
import { prepareDecisionHttpRequest } from './transport.js';

/** Zero rates are the existing verified operator tariff contract. The API publishes no maximum paid request bound;
 * nonzero tariffs remain unavailable instead of treating a response byte limit as a provider billing guarantee. */
export function quoteDecisionHttpOperatorTariff(input: ModelInvocationSpendingInput): ProviderSpendQuote {
  const profile = modelInvocationProfileSchema.parse(input.profile), binding = parseModelBindingDefinition(input.definition);
  if (profile.adapter.id !== decisionHttpAdapter.id || profile.adapter.version !== decisionHttpAdapter.version) throw new DecisionHttpError('DECISION_HTTP_DEFINITION_INVALID');
  const prepared = prepareDecisionHttpRequest(profile.adapter.definition, profile.limits, input.command.nativeRequest, binding.model.nativeId);
  if (!isDeepStrictEqual(input.prepared, prepared) || prepared.request.case.scope !== profile.scopeId
    || !isDeepStrictEqual(input.command.reference, profile.reference) || input.command.expectedBinding.digest !== profile.bindingDigest
    || input.command.scopeId !== profile.scopeId || modelInvocationRequestDigest(input.command) !== input.requestDigest
    || modelInvocationProfileDigest(profile) !== input.profileDigest) throw new DecisionHttpError('DECISION_HTTP_REQUEST_INVALID');
  const tariff = prepared.definition.tariff, tariffDigest = providerSpendEvidenceDigest(tariff);
  const evidence = { schemaVersion: 1, tariffDigest, bodyDigest: createHash('sha256').update(prepared.body).digest('hex'),
    calculation: { schemaVersion: 1, currency: tariff.currency, inputMinorUnitsPerMillionTokens: tariff.inputMinorUnitsPerMillionTokens,
      outputMinorUnitsPerMillionTokens: tariff.outputMinorUnitsPerMillionTokens, requestCount: 1 } };
  return parseProviderSpendQuote({ schemaVersion: 1, scopeId: input.command.scopeId, requestDigest: input.requestDigest, profileDigest: input.profileDigest,
    pricing: { id: OPERATOR_TARIFF_PRICING_ID, version: 1, digest: tariffDigest, definition: tariff },
    meter: { id: decisionHttpProtocolData.meterId, version: 1, evidenceDigest: providerSpendEvidenceDigest(evidence), evidence },
    currency: tariff.currency, maxChargeMinorUnits: 0 });
}
