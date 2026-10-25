import { z } from 'zod';
import { modelInvocationProfileSchema, parseModelBindingDefinition, delegatedUseConsentSchema, openAiChatDialectSchema,
  type HeadlessRejectionBody, type ModelInvocationDeltaSink } from '#domain/index.js';
import { createModelInvocationResponseEvidence, modelInvocationNativeResponseUpperBound, type ModelInvocationNativePort,
  type OAuthAccessTokenLease } from '#engine/index.js';
import { createResponsesStream, openAiChatWireObjectSchema, OpenAiChatHttpError, parseOpenAiChatTextRequest,
  OPENAI_CHAT_TOOL_CALLS_CAPABILITY, OPENAI_CHAT_COMPLETIONS_FAMILY, OPENAI_CHAT_COMPLETIONS_VERSION } from '#adapters/core/provider-openai-chat/index.js';
import { sendNativeJsonHttp } from '#adapters/core/provider-http-json/index.js';
import { SIWC_INFERENCE as I } from './registry.js';
import { siwcResponsesBody, siwcRejection } from './responses.js';

export const siwcResponsesDefinitionSchema = z.object({ schemaVersion: z.literal(1), connectionId: z.string().uuid(),
  owner: z.object({ issuer: z.string().min(1), subject: z.string().min(1) }).strict(), rawUse: z.literal('person'),
  delegatedUse: delegatedUseConsentSchema.nullable(), apiContinuation: z.null(), dialect: openAiChatDialectSchema.optional() }).strict().readonly();
/** Lease is a trusted host-side closure over a verified caller, never a secret-name resolver or request-supplied token. */
export function createSiwcResponsesPort(options: { readonly now: () => number;
  readonly lease: (connectionId: string, signal?: AbortSignal) => Promise<OAuthAccessTokenLease> }): ModelInvocationNativePort {
  type Prepared = { definition: z.infer<typeof siwcResponsesDefinitionSchema>; limits: { requestMaxBytes: number; responseMaxBytes: number; timeoutMs: number };
    request: ReturnType<typeof parseOpenAiChatTextRequest>; body: string };
  const prepared = new WeakSet<object>();
  const target = (value: unknown): Prepared => {
    if (!value || typeof value !== 'object' || !prepared.has(value)) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
    return value as Prepared;
  };
  return Object.freeze({
    billingAxis: 'subscription' as const,
    responseBytesUpperBound(value: unknown) { return modelInvocationNativeResponseUpperBound(target(value).limits.responseMaxBytes); },
    async prepare(profileInput: unknown, bindingInput: unknown, requestInput: unknown) {
      const envelope = openAiChatWireObjectSchema.safeParse(profileInput), profile = envelope.success && modelInvocationProfileSchema.safeParse(envelope.data);
      if (!profile || !profile.success || profile.data.schemaVersion !== 2 || profile.data.billingAxis !== 'subscription'
        || profile.data.adapter.id !== I.adapter.id || profile.data.adapter.version !== I.adapter.version
        || profile.data.protocol.family !== OPENAI_CHAT_COMPLETIONS_FAMILY || profile.data.protocol.version !== OPENAI_CHAT_COMPLETIONS_VERSION)
        throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
      const definition = siwcResponsesDefinitionSchema.safeParse(profile.data.adapter.definition);
      if (!definition.success || definition.data.dialect && definition.data.dialect.protocol !== 'responses') throw new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID');
      const binding = parseModelBindingDefinition(openAiChatWireObjectSchema.parse(bindingInput));
      const request = parseOpenAiChatTextRequest(requestInput, { maxOutputTokens: Number.MAX_SAFE_INTEGER });
      if (request.model !== binding.model.nativeId) throw new OpenAiChatHttpError('OPENAI_CHAT_MODEL_MISMATCH');
      if (request.tools && !binding.model.protocols.some(protocol => protocol.family === OPENAI_CHAT_COMPLETIONS_FAMILY && protocol.version === OPENAI_CHAT_COMPLETIONS_VERSION
        && protocol.capabilities.some(capability => capability.id === OPENAI_CHAT_TOOL_CALLS_CAPABILITY && capability.version === 1 && capability.state === 'supported')))
        throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
      const body = JSON.stringify(siwcResponsesBody(request));
      if (Buffer.byteLength(body) > profile.data.limits.requestMaxBytes) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_TOO_LARGE');
      const value = Object.freeze({ definition: definition.data, limits: profile.data.limits, request, body }); prepared.add(value); return value;
    },
    async send(value: unknown, signal?: AbortSignal, onDelta?: ModelInvocationDeltaSink) {
      const input = target(value); prepared.delete(input);
      let refusal: HeadlessRejectionBody | null = null;
      const stream = createResponsesStream(input.request, input.limits, undefined, undefined, undefined,
        { completedOnly: true, enforceOutputLimit: false, functionNamespace: I.namespace.name, onError: event => {
          const response = event['response'] as { model?: unknown } | undefined;
          if (event['type'] === 'error' || response?.model === input.request.model) refusal = siwcRejection(event['response'] ?? { error: event }, null);
        } });
      const result = await sendNativeJsonHttp({ definition: { endpoint: I.endpoint,
        authentication: { type: 'bearer', credentialRef: 'SIWC_ACCESS_TOKEN' } }, adapter: I.adapter, body: input.body, limits: input.limits },
      { stream, ...(onDelta ? { onDelta } : {}), resolveCredential: async (_reference, bounded) => {
        const lease = await options.lease(input.definition.connectionId, bounded);
        if (bounded?.aborted || !Number.isSafeInteger(lease.expiresAtMs) || options.now() >= lease.expiresAtMs) throw new OpenAiChatHttpError('OPENAI_CHAT_CREDENTIAL_UNAVAILABLE');
        return lease.accessToken;
      } }, signal);
      if (!('kind' in result) || result.kind !== 'rejected' || !result.evidence.body.complete) return result;
      const status = result.evidence.httpStatus;
      if (result.evidence.reason === 'http-status') {
        try { refusal = siwcRejection(JSON.parse(Buffer.from(result.evidence.body.data, 'base64').toString('utf8')), status); }
        catch { /* Only a complete structured error can name a provider refusal. */ }
      }
      return refusal ? Object.freeze({ kind: 'rejected' as const, evidence: createModelInvocationResponseEvidence(I.adapter,
        result.evidence.reason, status, Buffer.from(JSON.stringify(refusal)), true) }) : result;
    },
  });
}
