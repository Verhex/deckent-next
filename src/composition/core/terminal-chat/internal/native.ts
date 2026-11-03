import type { ModelInvocationProfile } from '#domain/index.js';
import { modelInvocationProfileDigest } from '#engine/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
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
  if (!definition.success || readiness.execution.executable !== definition.data.executable || readiness.execution.ownerUid !== definition.data.ownerUid)
    return { state: 'unavailable', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' } as const;
  return readiness;
}
