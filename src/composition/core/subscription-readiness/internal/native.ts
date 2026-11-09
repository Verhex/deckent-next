import { isDeepStrictEqual } from 'node:util';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { modelInvocationProfileSchema, type ModelInvocationProfile } from '#domain/index.js';
import { modelInvocationProfileDigest } from '#engine/index.js';
import { readNativeAgentObservation, isNativeCliHeadlessAdapter, nativeAgentFlagSetDigest, nativeCliAgent, agentGlobalStateRoots } from '#adapters/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { SubscriptionReadinessQuery, SubscriptionReadinessReader, SubscriptionReadinessSurface } from './readiness.js';

/** The readiness query for a native profile: expected digests from the profile and its registry entry (null: the family has no agent entry). */
export function nativeReadinessQuery(profile: ModelInvocationProfile, surface: SubscriptionReadinessSurface): SubscriptionReadinessQuery | null {
  const entry = nativeCliAgent(profile.protocol.family);
  return entry && { surface, scopeId: profile.scopeId, reference: profile.reference, profileDigest: modelInvocationProfileDigest(profile), flagSetDigest: nativeAgentFlagSetDigest(entry) };
}
/** Exact chat observation reader shared by the service and terminal. This never performs an inspection run. */
export function configuredNativeChatReadiness(projectRoot: string, options: ConfigLoadOptions = {}, display = false): SubscriptionReadinessReader {
  const reader: SubscriptionReadinessReader = { async read(query) {
    if (query.surface !== 'chat' && query.surface !== 'worker') return null;
    const config = await loadComposedConfig(projectRoot, { ...options, force: true, heal: false }) as Record<string, unknown>;
    const profile = ((config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? [])
      .map(value => modelInvocationProfileSchema.parse(value)).find(profile => profile.scopeId === query.scopeId
        && isDeepStrictEqual(profile.reference, query.reference) && isNativeCliHeadlessAdapter(profile.adapter));
    const expected = profile && nativeReadinessQuery(profile, query.surface);
    if (!profile || !expected || expected.profileDigest !== query.profileDigest || expected.flagSetDigest !== query.flagSetDigest) return null;
    const observed = await readNativeAgentObservation(profile, Date.now, display); // R8e: display reads the last verification; gates never pass `display`
    if (!observed) return null;
    // K15 seals installation-global roots. A custom login outside them has no tool-realm custody proof.
    const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'); };
    const roots = agentGlobalStateRoots([options.env ?? process.env, process.env]);
    for (const path of [profile.adapter.definition['configDir'], profile.adapter.definition['stateDir']]) {
      if (typeof path !== 'string') return { environment: false };
      const resolved = await realpath(path).catch(() => null);
      const candidates = await Promise.all(roots.filter(root => inside(root, path)).map(root => realpath(root).catch(() => null)));
      if (!resolved || !candidates.some(root => root && inside(root, resolved))) return { environment: false };
    }
    return observed;
  } };
  return Object.freeze(reader);
}
