import { DeckentError, headlessDiagnostic } from '#platform/index.js';
import type { ModelInvocationProfile } from '#domain/index.js';
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
  if (!query) return { state: 'unavailable', reason: 'NATIVE_AGENT_BRIDGE_UNAVAILABLE',
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

/** Invocation-only eligibility: missing surface facts may be checked by the guarded first turn; false never is eligible. */
export async function nativeChatVerificationExecution(profile: ModelInvocationProfile, runtime: { readonly readiness: SubscriptionReadinessReader },
  diagnose?: (error: DeckentError) => void) {
  const query = nativeReadinessQuery(profile, 'chat');
  if (!query) return null;
  const observed = await runtime.readiness.read(query);
  const prerequisites = await inspectSubscriptionReadiness(query, { read: async () => observed }, { unknownSurfaceFacts: 'allow' });
  if (prerequisites.state !== 'ready') {
    if (prerequisites.diagnostic) diagnose?.(prerequisites.diagnostic);
    return null;
  }
  const seal = await sealedForProfile(profile, prerequisites.execution);
  if (seal instanceof DeckentError) diagnose?.(seal);
  return seal === true ? prerequisites.execution : null;
}
