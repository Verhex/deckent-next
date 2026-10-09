import { isDeepStrictEqual } from 'node:util';
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
  const models: { reference: ModelReference; ttl: string; modelId: string; writeRatio: number; readRatio: number }[] = [];
  const writes: { layer: ModelConnectLayer; value: Record<string, unknown> }[] = [], shared: ModelReference[] = [];
  const profilesOf = (layer: ModelConnectLayer) => (layers[layer]['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles;
  const mine = (profile: unknown) => { const item = profile as { scopeId?: unknown; reference?: ModelReference } | null; return item?.scopeId === scopeId && item.reference ? item.reference : null; };
  const inProject = Array.isArray(profilesOf('global')) ? (profilesOf('project') ?? []).flatMap(profile => { const reference = mine(profile); return reference ? [reference] : []; }) : [];
  const blocked = (reference: ModelReference) => inProject.some(item => isDeepStrictEqual(item, reference));
  for (const layer of ['global', 'project'] as const) {
    const document = layers[layer]['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined;
    if (!Array.isArray(document?.profiles)) continue;
    let changed = false;
    const profiles = document.profiles.map(profile => {
      const reference = mine(profile), offered = reference ? offer(profile) : null;
      if (!reference || !offered) return profile;
      if (blocked(reference)) { if (!shared.some(item => isDeepStrictEqual(item, reference))) shared.push(reference); return profile; }
      changed = true;
      if (!models.some(model => isDeepStrictEqual(model.reference, reference))) models.push({ reference, ttl: offered.ttl, modelId: offered.modelId,
        writeRatio: offered.writeRatio, readRatio: offered.readRatio });
      return offered.next;
    });
    if (changed) writes.push({ layer, value: { ...document, profiles } });
  }
  return { models, writes, shared };
}
