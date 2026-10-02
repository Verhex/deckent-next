import { performance } from 'node:perf_hooks';
import { modelInvocationProfileSchema, parseModelBindingDefinition, type ModelInvocationNativeResult } from '#domain/index.js';
import { modelInvocationNativeResponseUpperBound, type ModelInvocationNativePort } from '#engine/index.js';
import { sendNativeJsonHttp } from '#adapters/core/provider-http-json/index.js';
import { decisionAdviceFromWire } from './advice.js';
import { DecisionHttpError, decisionHttpAdapter, decisionHttpProtocolData, decisionHttpWireObjectSchema, parseDecisionHttpDefinition,
  parseDecisionHttpLimits, parseDecisionHttpRequest, rethrowDecisionHttpTransport, type DecisionHttpDefinition, type DecisionHttpLimits } from './contract.js';

export type PreparedDecisionHttpRequest = Readonly<{ definition: DecisionHttpDefinition; limits: DecisionHttpLimits;
  request: ReturnType<typeof parseDecisionHttpRequest>; model: string; body: string }>;
export interface DecisionHttpNativeOptions { readonly resolveCredential?: (reference: string, signal?: AbortSignal) => Promise<string | undefined> }

/** Case serialization and validation are pure; credentials resolve only inside the shared send. */
export function prepareDecisionHttpRequest(definitionInput: unknown, limitsInput: unknown, requestInput: unknown, model: string): PreparedDecisionHttpRequest {
  const definition = parseDecisionHttpDefinition(definitionInput), limits = parseDecisionHttpLimits(limitsInput), request = parseDecisionHttpRequest(requestInput);
  if (typeof model !== 'string' || !model || model.length > 1024) throw new DecisionHttpError('DECISION_HTTP_REQUEST_INVALID');
  const criteria = Object.fromEntries(request.case.options.map(option => [option.id, { action: option.action, tradeoffs: option.tradeoffs, evidenceIds: option.evidenceIds }]));
  Object.assign(criteria, decisionHttpProtocolData.abstentions);
  const questions: Record<string, unknown> = { selection: { type: 'choice', instructions: decisionHttpProtocolData.selectionInstructions, criteria },
    sufficiency: { type: 'noul', instructions: decisionHttpProtocolData.sufficiencyInstructions } };
  for (const [index, check] of request.case.checks.entries()) questions[`check_${index}`] = { type: 'noul', instructions: { question: check.instructions, evidenceIds: check.evidenceIds } };
  const body = JSON.stringify({ state: request.case, model, questions });
  if (Buffer.byteLength(body, 'utf8') > limits.requestMaxBytes) throw new DecisionHttpError('DECISION_HTTP_REQUEST_TOO_LARGE');
  return Object.freeze({ definition, limits, request, model, body });
}

export function createDecisionHttpNativePort(options: DecisionHttpNativeOptions = {}): ModelInvocationNativePort {
  const tokens = new WeakSet<object>();
  const checked = (input: unknown): PreparedDecisionHttpRequest => {
    if (!input || typeof input !== 'object' || !tokens.has(input)) throw new DecisionHttpError('DECISION_HTTP_REQUEST_INVALID');
    return input as PreparedDecisionHttpRequest;
  };
  return Object.freeze({
    responseBytesUpperBound(input: unknown) { return modelInvocationNativeResponseUpperBound(checked(input).limits.responseMaxBytes); },
    async prepare(profileInput: unknown, bindingInput: unknown, requestInput: unknown) {
      const copied = decisionHttpWireObjectSchema.safeParse(profileInput), profile = copied.success && modelInvocationProfileSchema.safeParse(copied.data);
      if (!profile || !profile.success || profile.data.adapter.id !== decisionHttpAdapter.id || profile.data.adapter.version !== decisionHttpAdapter.version
        || profile.data.protocol.family !== decisionHttpAdapter.protocol.family || profile.data.protocol.version !== decisionHttpAdapter.protocol.version) throw new DecisionHttpError('DECISION_HTTP_DEFINITION_INVALID');
      const bindingCopied = decisionHttpWireObjectSchema.safeParse(bindingInput);
      if (!bindingCopied.success) throw new DecisionHttpError('DECISION_HTTP_REQUEST_INVALID');
      let binding: ReturnType<typeof parseModelBindingDefinition>;
      try { binding = parseModelBindingDefinition(bindingCopied.data); } catch { throw new DecisionHttpError('DECISION_HTTP_REQUEST_INVALID'); }
      if (!binding.model.protocols.some(candidate => candidate.family === decisionHttpAdapter.protocol.family && candidate.version === decisionHttpAdapter.protocol.version)) throw new DecisionHttpError('DECISION_HTTP_REQUEST_INVALID');
      const prepared = prepareDecisionHttpRequest(profile.data.adapter.definition, profile.data.limits, requestInput, binding.model.nativeId);
      if (prepared.request.case.scope !== profile.data.scopeId) throw new DecisionHttpError('DECISION_HTTP_REQUEST_INVALID');
      tokens.add(prepared); return prepared;
    },
    async send(input: unknown, signal?: AbortSignal): Promise<ModelInvocationNativeResult> {
      const prepared = checked(input); tokens.delete(prepared); const started = performance.now();
      try {
        return await sendNativeJsonHttp({ definition: { endpoint: prepared.definition.endpoint, authentication: prepared.definition.authentication,
          ...(prepared.definition.tls ? { tls: prepared.definition.tls } : {}) }, limits: prepared.limits, body: prepared.body,
          adapter: { id: decisionHttpAdapter.id, version: decisionHttpAdapter.version } }, { ...options, parseResponse(body) {
          let wire: unknown; try { wire = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return { reason: 'invalid-response' }; }
          const advice = decisionAdviceFromWire(wire, prepared.request.case, Math.max(0, Math.round(performance.now() - started)));
          if (!advice) return { reason: 'invalid-response' };
          const native = { decisionAdvice: advice }, usage = { input_tokens: advice.usage.inputTokens, output_tokens: advice.usage.outputTokens };
          if (Buffer.byteLength(JSON.stringify(native), 'utf8') > prepared.limits.responseMaxBytes) return { reason: 'response-limit' };
          return { response: Object.freeze({ schemaVersion: 1, native, usage }) };
        } }, signal);
      } catch (error) { rethrowDecisionHttpTransport(error); }
    },
  });
}
