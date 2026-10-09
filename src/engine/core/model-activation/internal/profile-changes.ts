import { isDeepStrictEqual } from 'node:util';
import type { ModelReference } from '#domain/index.js';
import type { ModelConnectLayer } from './connect.js';

export type ProfileChange<T> = Readonly<{ next: Record<string, unknown>; detail: T }>;
export type ProfileChangePlan<T> = Readonly<{ models: readonly Readonly<{ reference: ModelReference; detail: T }>[];
  writes: readonly Readonly<{ layer: ModelConnectLayer; value: Record<string, unknown> }>[];
  shared: readonly ModelReference[] }>;

/** Shared selection-only migration planner. Scope, authored-layer ownership and the project subset rule are invariant across migrations. */
export function planProfileChanges<T>(layers: Readonly<Record<ModelConnectLayer, Record<string, unknown>>>, scopeId: string,
  offer: (profile: unknown) => ProfileChange<T> | null): ProfileChangePlan<T> {
  const models: { reference: ModelReference; detail: T }[] = [], writes: { layer: ModelConnectLayer; value: Record<string, unknown> }[] = [], shared: ModelReference[] = [];
  const profilesOf = (layer: ModelConnectLayer) => (layers[layer]['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles;
  const mine = (profile: unknown) => { const item = profile as { scopeId?: unknown; reference?: ModelReference } | null; return item?.scopeId === scopeId && item.reference ? item.reference : null; };
  const inProject = Array.isArray(profilesOf('global')) ? (profilesOf('project') ?? []).flatMap(profile => { const reference = mine(profile); return reference ? [reference] : []; }) : [];
  for (const layer of ['global', 'project'] as const) {
    const document = layers[layer]['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined;
    if (!Array.isArray(document?.profiles)) continue;
    let changed = false;
    const profiles = document.profiles.map(profile => {
      const reference = mine(profile), offered = reference ? offer(profile) : null;
      if (!reference || !offered) return profile;
      if (inProject.some(item => isDeepStrictEqual(item, reference))) {
        if (!shared.some(item => isDeepStrictEqual(item, reference))) shared.push(reference);
        return profile;
      }
      changed = true;
      if (!models.some(model => isDeepStrictEqual(model.reference, reference))) models.push({ reference, detail: offered.detail });
      return offered.next;
    });
    if (changed) writes.push({ layer, value: { ...document, profiles } });
  }
  return { models, writes, shared };
}
