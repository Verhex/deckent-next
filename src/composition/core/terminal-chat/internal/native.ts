import { DeckentError, ErrorRegistry, headlessDiagnostic, messageText } from '#platform/index.js';
import { NATIVE_CLI_HEADLESS_ADAPTER_ID, type ModelInvocationProfile, type ModelInvocationResponseContent } from '#domain/index.js';
import { readSubscriptionRejection, type ModelInvocationResult } from '#engine/index.js';
import { nativeCliAgent, resolveHeadlessExecutable, SIWC_INFERENCE } from '#adapters/index.js';
import { nativeCliHeadlessDefinitionSchema, sealMatchesDefinition, type NativeAgentExecution, type NativeAgentReadiness } from '#capabilities/index.js';
import { inspectSubscriptionReadiness, nativeReadinessQuery, type SubscriptionReadinessReader } from '#composition/core/subscription-readiness/index.js';

/** Compare the chat seal with the same verified program used to create it. */
async function sealedForProfile(profile: ModelInvocationProfile, execution: NativeAgentExecution) {
  const definition = nativeCliHeadlessDefinitionSchema.safeParse(profile.adapter.definition);
  const entry = nativeCliAgent(profile.protocol.family);
  if (!definition.success || !entry) return headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-readiness-query-unavailable' });
  const { executable, ownerUid } = definition.data;
  if (execution.ownerUid !== ownerUid) return headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-owner-mismatch' });
  return sealMatchesDefinition(execution, definition.data,
    () => resolveHeadlessExecutable(entry, executable, ownerUid).then(program => program.executable))
    .then(matched => matched ? true : headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-program-path-mismatch' }),
      (error: unknown) => error instanceof DeckentError ? error
        : headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'recorded-program-unverified' }));
}

export async function inspectNativeChat(profile: ModelInvocationProfile, runtime?: { readonly readiness: SubscriptionReadinessReader }): Promise<NativeAgentReadiness & { readonly diagnostic?: DeckentError }> {
  if (!runtime) return { state: 'unknown', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED',
    diagnostic: headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-readiness-verifier-unavailable' }) };
  const query = nativeReadinessQuery(profile, 'chat');
  if (!query) return { state: 'unavailable', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED',
    diagnostic: headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-readiness-query-unavailable' }) };
  const readiness = await inspectSubscriptionReadiness(query, runtime.readiness);
  if (readiness.state !== 'ready') return readiness;
  const seal = await sealedForProfile(profile, readiness.execution);
  return seal === true ? readiness : { state: 'unavailable', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED',
    ...(seal && { diagnostic: seal }) } as const;
}

/** NF-7 (presentation only, never a gate): when the last tool verification still reads ready past the K16 age (R8e display read), its time. */
export async function nativeChatVerifiedAtMs(profile: ModelInvocationProfile, display: SubscriptionReadinessReader): Promise<number | null> {
  const query = nativeReadinessQuery(profile, 'chat');
  const observed = query && await display.read(query).catch(() => null);
  if (!query || (await inspectNativeChat(profile, { readiness: { read: async () => observed } })).state !== 'ready') return null;
  return typeof observed?.checkedAtMs === 'number' ? observed.checkedAtMs : null;
}

/** Missing surface facts may be checked by a guarded first turn. An observed false still blocks it. */
export async function inspectNativeChatForVerification(profile: ModelInvocationProfile, runtime: { readonly readiness: SubscriptionReadinessReader }) {
  const query = nativeReadinessQuery(profile, 'chat');
  if (!query) return { readiness: await inspectNativeChat(profile, runtime), execution: null };
  const observed = await runtime.readiness.read(query);
  const reader = { read: async () => observed };
  const readiness = await inspectSubscriptionReadiness(query, reader);
  const prerequisites = readiness.state === 'unknown'
    ? await inspectSubscriptionReadiness(query, reader, { unknownSurfaceFacts: 'allow' }) : readiness;
  if (prerequisites.state !== 'ready') return { readiness, execution: null };
  const seal = await sealedForProfile(profile, prerequisites.execution);
  return seal === true ? { readiness, execution: prerequisites.execution }
    : { readiness: { state: 'unavailable', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED', diagnostic: seal } as const, execution: null };
}

/** Kept for callers that need only the invocation eligibility projection. */
export async function nativeChatVerificationExecution(profile: ModelInvocationProfile, runtime: { readonly readiness: SubscriptionReadinessReader },
  diagnose?: (error: DeckentError) => void) {
  const { readiness, execution } = await inspectNativeChatForVerification(profile, runtime);
  if (readiness.diagnostic) diagnose?.(readiness.diagnostic);
  return execution;
}

function subscriptionFailureEvidence(result: ModelInvocationResult) {
  const { profile, outcome } = result.receipt;
  const evidence = outcome?.state === 'unknown' || outcome?.state === 'rejected' ? outcome.evidence : null;
  return (profile.adapter.id === NATIVE_CLI_HEADLESS_ADAPTER_ID || profile.adapter.id === SIWC_INFERENCE.adapter.id)
    && evidence?.adapter.id === profile.adapter.id && evidence.adapter.version === profile.adapter.version ? evidence : null;
}

export const hasRetainedSubscriptionFailure = (result: ModelInvocationResult) => subscriptionFailureEvidence(result) !== null;

/** Only project facts permitted by the authorized, adapter-matched receipt. */
export function readRetainedSubscriptionFailure(result: ModelInvocationResult, content: ModelInvocationResponseContent | null | undefined): DeckentError | null {
  const evidence = subscriptionFailureEvidence(result);
  if (!evidence || content?.kind !== 'response-body') return null;
  const native = evidence.adapter.id === NATIVE_CLI_HEADLESS_ADAPTER_ID;
  const body = readSubscriptionRejection({ adapter: evidence.adapter, body: { data: content.data } }, new Set([evidence.adapter.id]));
  if (!body) {
    const code = native && result.receipt.outcome?.state === 'unknown' && evidence.reason === 'interrupted' ? retainedFailureCode(content.data) : null;
    return code ? ErrorRegistry.createError('TERMINAL_CHAT_RECORDED_FAILURE', { params: { code } }) : null;
  }
  switch (body.refusal) {
    case 'usage-unavailable': return ErrorRegistry.createError('SIWC_USAGE_UNAVAILABLE');
    case 'service-unavailable': return ErrorRegistry.createError('SIWC_SERVICE_UNAVAILABLE');
    case 'plan-unavailable': return ErrorRegistry.createError('HEADLESS_PLAN_UNAVAILABLE');
    case 'credits-required': return native ? ErrorRegistry.createError('HEADLESS_CREDITS_REQUIRED') : null;
    case 'quota': {
      if (!native) return ErrorRegistry.createError('TERMINAL_CHAT_REJECTED', { params: { refusal: 'siwc-quota' } });
      // Preserve known quota windows and reset times without displaying retained free-form fields.
      const window = body.field && /^[a-z_]+$/u.test(body.field) && messageText(`headless.chat.quotaWindow.${body.field}`, 'en') ? body.field : '?';
      return ErrorRegistry.createError('TERMINAL_CHAT_REJECTED', { params: { refusal: 'quota',
        ...(body.subtype !== undefined && { window, ...(body.resetsAtMs != null && { resetsAtMs: body.resetsAtMs }) }) } });
    }
    case 'resource-limit': {
      const { field } = body;
      return native && (field === 'cpu-time' || field === 'processes' || field === 'memory')
        ? headlessDiagnostic('HEADLESS_LIMIT_REACHED', { limit: field }) : null;
    }
    case 'process-exit':
      if (!native) return null;
      if (body.exitCode !== null && body.signal === null)
        return ErrorRegistry.createError('TERMINAL_CHAT_PROCESS_EXIT', { params: { code: body.exitCode } });
      return body.exitCode === null && body.signal !== null
        ? ErrorRegistry.createError('TERMINAL_CHAT_PROCESS_EXIT', { params: { observedSignal: 'true' } }) : null;
    case 'guard':
      return native ? ErrorRegistry.createError('TERMINAL_CHAT_REJECTED', { params: {
        refusal: body.field === 'agent-surface:rate-limit-status' ? 'quota-status-unrecognized' : 'guard',
      } }) : null;
    case 'model-mismatch':
      return native ? ErrorRegistry.createError('TERMINAL_CHAT_REJECTED', { params: {
        refusal: body.subtype === 'model-reported' ? 'model-mismatch' : 'invalid-output',
      } }) : null;
    case 'response-limit':
    case 'login-required':
    case 'invalid-output':
    case 'provider-error': return native ? ErrorRegistry.createError('TERMINAL_CHAT_REJECTED', { params: { refusal: body.refusal } }) : null;
  }
}

/** The code-only body names a registered family without identifying an operation or proving cancellation. */
function retainedFailureCode(data: string): string | null {
  try {
    const body: unknown = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    return body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1
      && 'code' in body && typeof body.code === 'string' && ErrorRegistry.has(body.code) ? body.code : null;
  } catch { return null; }
}
