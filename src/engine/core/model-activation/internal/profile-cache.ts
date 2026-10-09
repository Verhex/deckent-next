import { planProfileChanges } from './profile-changes.js';
import type { ModelReference } from '#domain/index.js';
import type { ModelConnectLayer } from './connect.js';

/** One existing profile's cache migration as the adapter offers it (engine never reads a vendor definition itself). */
export type ProfileCacheOffer = Readonly<{ ttl: string; modelId: string; writeRatio: number; readRatio: number; next: Record<string, unknown> }>;
export type ProfileCachePlan = Readonly<{ models: readonly Readonly<{ reference: ModelReference; ttl: string; modelId: string; writeRatio: number; readRatio: number }>[];
  writes: readonly Readonly<{ layer: ModelConnectLayer; value: Record<string, unknown> }>[];
  /** Offered profiles the project layer also authors under an authored user layer: the layer rule (a project profile must equal one of the user
   * layer's) admits no sequence of single-layer writes that changes both copies, so they are left as they are and named. */
  shared: readonly ModelReference[] }>;

/**
 * CACHE-SLICE1: which of this scope's existing invocation profiles the adapter offers to switch the prompt cache on, and the one governed write per
 * authored layer that does it (the whole `provider_invocation_profiles` document of that layer, other profiles untouched). Nothing is offered for a
 * profile with an explicit choice; an empty plan writes nothing. Pure: the caller reads the layers fresh and writes through the config writer.
 */
export function planProfileCache(layers: Readonly<Record<ModelConnectLayer, Record<string, unknown>>>, scopeId: string,
  offer: (profile: unknown) => ProfileCacheOffer | null): ProfileCachePlan {
  const plan = planProfileChanges(layers, scopeId, profile => {
    const value = offer(profile);
    if (!value) return null;
    const { next, ...detail } = value;
    return { next, detail };
  });
  return { ...plan, models: plan.models.map(({ reference, detail }) => ({ reference, ...detail })) };
}
