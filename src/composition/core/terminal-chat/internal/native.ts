import type { ModelInvocationProfile } from '#domain/index.js';
import { realpath } from 'node:fs/promises';
import { modelInvocationProfileDigest } from '#engine/index.js';
import { nativeCliAgent } from '#adapters/index.js';
import { nativeAgentFlagSetDigest, nativeCliHeadlessDefinitionSchema } from '#adapters/index.js';
import { inspectSubscriptionReadiness, type SubscriptionReadinessReader } from '#composition/core/subscription-readiness/index.js';

export async function inspectNativeChat(profile: ModelInvocationProfile, runtime?: { readonly readiness: SubscriptionReadinessReader }) {
  if (!runtime) return { state: 'unknown', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' } as const;
  const entry = nativeCliAgent(profile.protocol.family);
  if (!entry) return { state: 'unavailable', reason: 'NATIVE_AGENT_BRIDGE_UNAVAILABLE' } as const;
  const readiness = await inspectSubscriptionReadiness({ surface: 'chat', scopeId: profile.scopeId, reference: profile.reference,
    profileDigest: modelInvocationProfileDigest(profile), flagSetDigest: nativeAgentFlagSetDigest(entry) }, runtime.readiness);
  if (readiness.state !== 'ready') return readiness;
  const definition = nativeCliHeadlessDefinitionSchema.safeParse(profile.adapter.definition);
  if (!definition.success || readiness.execution.executable !== await realpath(definition.data.executable).catch(() => null) || readiness.execution.ownerUid !== definition.data.ownerUid)
    return { state: 'unavailable', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' } as const;
  return readiness;
}

/** NF-7 (presentation only, never a gate): when the last tool verification still reads ready past the K16 age (R8e display read), its time. */
export async function nativeChatVerifiedAtMs(profile: ModelInvocationProfile, display: SubscriptionReadinessReader): Promise<number | null> {
  const entry = nativeCliAgent(profile.protocol.family);
  if (!entry || (await inspectNativeChat(profile, { readiness: display })).state !== 'ready') return null;
  const observed = await display.read({ surface: 'chat', scopeId: profile.scopeId, reference: profile.reference, profileDigest: modelInvocationProfileDigest(profile), flagSetDigest: nativeAgentFlagSetDigest(entry) });
  return typeof observed?.checkedAtMs === 'number' ? observed.checkedAtMs : null;
}

/** Invocation-only eligibility: missing surface facts may be checked by the guarded first turn; false never is eligible. */
export async function nativeChatVerificationExecution(profile: ModelInvocationProfile, runtime: { readonly readiness: SubscriptionReadinessReader }) {
  const entry = nativeCliAgent(profile.protocol.family);
  if (!entry) return null;
  const query = { surface: 'chat' as const, scopeId: profile.scopeId, reference: profile.reference,
    profileDigest: modelInvocationProfileDigest(profile), flagSetDigest: nativeAgentFlagSetDigest(entry) };
  const observed = await runtime.readiness.read(query);
  if (!observed || [observed.plugins, observed.toolSurface, observed.bridge].some(value => value === false)) return null;
  // Reuse the seal and prerequisite validation without presenting unknown surface facts as a ready seal.
  const prerequisites = await inspectSubscriptionReadiness({ ...query, surface: 'brain' }, { read: async () => observed });
  const definition = nativeCliHeadlessDefinitionSchema.safeParse(profile.adapter.definition);
  if (prerequisites.state !== 'ready' || !definition.success || prerequisites.execution.ownerUid !== definition.data.ownerUid
    || prerequisites.execution.executable !== await realpath(definition.data.executable).catch(() => null)) return null;
  return prerequisites.execution;
}
