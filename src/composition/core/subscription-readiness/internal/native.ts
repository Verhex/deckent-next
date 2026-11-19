import { isDeepStrictEqual } from 'node:util';
import type { ModelInvocationProfile } from '#domain/index.js';
import { modelInvocationProfileDigest, configuredInvocationProfiles } from '#engine/index.js';
import { readNativeAgentObservation, isNativeCliHeadlessAdapter, nativeAgentFlagSetDigest, nativeCliAgent } from '#adapters/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { inspectNativeStateCustody, type ConfigLoadOptions } from '#platform/index.js';
import type { SubscriptionReadinessQuery, SubscriptionReadinessReader, SubscriptionReadinessSurface } from './readiness.js';

/** The readiness query for a native profile: expected digests from the profile and its registry entry (null: the family has no agent entry). */
export function nativeReadinessQuery(profile: ModelInvocationProfile, surface: SubscriptionReadinessSurface): SubscriptionReadinessQuery | null {
  const entry = nativeCliAgent(profile.protocol.family);
  return entry && { surface, scopeId: profile.scopeId, reference: profile.reference, profileDigest: modelInvocationProfileDigest(profile), flagSetDigest: nativeAgentFlagSetDigest(entry) };
}
/** Exact chat observation reader shared by the service and terminal. This never performs an inspection run.
 * `profiles` (one display view build, KG6 F5): profiles that build read from its one validated forced load; gates pass none and load per read. */
export function configuredNativeChatReadiness(projectRoot: string, options: ConfigLoadOptions = {}, display = false, profiles?: readonly ModelInvocationProfile[]): SubscriptionReadinessReader {
  const reader: SubscriptionReadinessReader = { async read(query) {
    if (query.surface !== 'chat' && query.surface !== 'worker') return null;
    const profile = (profiles ?? configuredInvocationProfiles(await loadComposedConfig(projectRoot, { ...options, force: true, heal: false }) as Record<string, unknown>))
      .find(profile => profile.scopeId === query.scopeId
        && isDeepStrictEqual(profile.reference, query.reference) && isNativeCliHeadlessAdapter(profile.adapter));
    const expected = profile && nativeReadinessQuery(profile, query.surface);
    if (!profile || !expected || expected.profileDigest !== query.profileDigest || expected.flagSetDigest !== query.flagSetDigest) return null;
    const observed = await readNativeAgentObservation(profile, Date.now, display); // R8e: display reads the last verification; gates never pass `display`
    const custody = await inspectNativeStateCustody(profile.adapter.definition, options.env);
    if (custody === 'outside-installation') return { ...(observed ? { environment: false } : {}), governedUse: custody };
    if (observed && custody !== 'inside-installation') return { environment: false };
    return observed;
  } };
  return Object.freeze(reader);
}
