import { DeckentError, ErrorRegistry, headlessDiagnostic } from '#platform/index.js';
import { NATIVE_CLI_HEADLESS_ADAPTER_ID, type HeadlessRejectionBody, type ModelInvocationProfile, type ModelInvocationResponseContent } from '#domain/index.js';
import { readSubscriptionRejection, type ModelInvocationResult } from '#engine/index.js';
import { nativeCliAgent, resolveHeadlessExecutable } from '#adapters/index.js';
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

export function readRetainedHeadlessFailure(result: ModelInvocationResult, content: ModelInvocationResponseContent | null | undefined) {
  const { profile, outcome } = result.receipt;
  const evidence = outcome?.state === 'unknown' || outcome?.state === 'rejected' ? outcome.evidence : null;
  if (profile.adapter.id !== NATIVE_CLI_HEADLESS_ADAPTER_ID || evidence?.adapter.id !== profile.adapter.id
    || evidence.adapter.version !== profile.adapter.version || content?.kind !== 'response-body') return null;
  return { body: readSubscriptionRejection({ adapter: evidence.adapter, body: { data: content.data } }, new Set([profile.adapter.id])),
    code: outcome?.state === 'unknown' && evidence.reason === 'interrupted' ? retainedFailureCode(content.data) : null };
}

export function invocationResourceLimit(body: HeadlessRejectionBody | null) {
  if (body?.refusal !== 'resource-limit') return null;
  const { field } = body;
  return field === 'cpu-time' || field === 'processes' || field === 'memory' ? headlessDiagnostic('HEADLESS_LIMIT_REACHED', { limit: field }) : null;
}

/** The code-only body names a registered family without identifying an operation or proving cancellation. */
function retainedFailureCode(data: string): string | null {
  try {
    const body: unknown = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    return body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1
      && 'code' in body && typeof body.code === 'string' && ErrorRegistry.has(body.code) ? body.code : null;
  } catch { return null; }
}
