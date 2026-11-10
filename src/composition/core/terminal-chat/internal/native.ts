import type { ModelInvocationProfile } from '#domain/index.js';
import { realpath } from 'node:fs/promises';
import { nativeCliHeadlessDefinitionSchema, sealMatchesDefinition, type NativeAgentExecution } from '#capabilities/index.js';
import { inspectSubscriptionReadiness, nativeReadinessQuery, type SubscriptionReadinessReader } from '#composition/core/subscription-readiness/index.js';

/** Chat compares the seal with the profile's resolved executable only (never its recorded path). */
async function sealedForProfile(profile: ModelInvocationProfile, execution: NativeAgentExecution) {
  const definition = nativeCliHeadlessDefinitionSchema.safeParse(profile.adapter.definition);
  return definition.success && await sealMatchesDefinition(execution, definition.data, () => realpath(definition.data.executable).catch(() => null));
}

export async function inspectNativeChat(profile: ModelInvocationProfile, runtime?: { readonly readiness: SubscriptionReadinessReader }) {
  if (!runtime) return { state: 'unknown', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' } as const;
  const query = nativeReadinessQuery(profile, 'chat');
  if (!query) return { state: 'unavailable', reason: 'NATIVE_AGENT_BRIDGE_UNAVAILABLE' } as const;
  const readiness = await inspectSubscriptionReadiness(query, runtime.readiness);
  if (readiness.state !== 'ready') return readiness;
  return await sealedForProfile(profile, readiness.execution) ? readiness : { state: 'unavailable', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' } as const;
}

/** NF-7 (presentation only, never a gate): when the last tool verification still reads ready past the K16 age (R8e display read), its time. */
export async function nativeChatVerifiedAtMs(profile: ModelInvocationProfile, display: SubscriptionReadinessReader): Promise<number | null> {
  const query = nativeReadinessQuery(profile, 'chat');
  const observed = query && await display.read(query).catch(() => null);
  if (!query || (await inspectNativeChat(profile, { readiness: { read: async () => observed } })).state !== 'ready') return null;
  return typeof observed?.checkedAtMs === 'number' ? observed.checkedAtMs : null;
}

/** Invocation-only eligibility: missing surface facts may be checked by the guarded first turn; false never is eligible. */
export async function nativeChatVerificationExecution(profile: ModelInvocationProfile, runtime: { readonly readiness: SubscriptionReadinessReader }) {
  const query = nativeReadinessQuery(profile, 'chat');
  if (!query) return null;
  const observed = await runtime.readiness.read(query);
  const prerequisites = await inspectSubscriptionReadiness(query, { read: async () => observed }, { unknownSurfaceFacts: 'allow' });
  return prerequisites.state === 'ready' && await sealedForProfile(profile, prerequisites.execution) ? prerequisites.execution : null;
}
