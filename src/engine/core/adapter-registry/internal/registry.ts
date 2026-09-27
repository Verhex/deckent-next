import type { z } from 'zod';
import { admitModuleManifest, unifyOperationCatalog, RegistryError, type AdapterModuleManifest, type CatalogOperation, type OperationDescriptor, type OperationRef } from '#domain/index.js';
import type { EffectTarget, EffectTargets, OperationCatalog } from '#engine/core/effect/index.js';

/** Code side of one provided target adapter: a strict options schema whose output names the target `kind` (so configuration can
 * check kind uniqueness without constructing targets) and a factory that builds the target from validated options. */
export interface TargetAdapterFactory {
  readonly optionsSchema: z.ZodType<{ readonly kind: string }>;
  create(options: unknown): EffectTarget;
}
export interface AdapterModuleRegistration { readonly manifest: AdapterModuleManifest; readonly factories: Readonly<Record<string, TargetAdapterFactory>> }
/** The one operation catalog every producer resolves from (A04-2): Core code operations, registered module operations and the
 * installation's config catalog, unified without conflict. `entries()` carries provenance for inspection; it grants nothing. */
export interface UnifiedOperationCatalog extends OperationCatalog { entries(): readonly CatalogOperation[] }
export interface ResolvedTargetAdapter { readonly manifest: AdapterModuleManifest; readonly adapterId: string; readonly version: number; readonly factory: TargetAdapterFactory }
export interface ConfiguredTarget { readonly adapter: string; readonly options?: unknown }

const snapshot = (factory: TargetAdapterFactory): TargetAdapterFactory => {
  const { optionsSchema, create } = factory;
  return Object.freeze({ optionsSchema, create: (options: unknown) => create.call(factory, options) });
};
/** Versioned registry of target adapter modules. Modules passed to `create` are Core entries (root namespace); everything
 * registered afterwards is an overlay admitted by the manifest rules. `seal()` closes registration once a configuration was
 * validated against it, so a validated config never changes meaning afterwards. Registration never grants authority: policy
 * still decides every operation. */
export class AdapterRegistry {
  private readonly modules: (AdapterModuleRegistration & { readonly root: boolean })[] = [];
  private readonly adapters = new Map<string, ResolvedTargetAdapter>();
  private sealed = false;
  private constructor() {}
  static create(core: readonly AdapterModuleRegistration[]): AdapterRegistry {
    const registry = new AdapterRegistry();
    for (const registration of core) registry.admit(registration, true);
    return registry;
  }
  register(registration: AdapterModuleRegistration): void {
    if (this.sealed) throw new RegistryError('REGISTRY_SEALED');
    this.admit(registration, false);
  }
  seal(): void { this.sealed = true; }
  manifests(): readonly AdapterModuleManifest[] { return this.modules.map(module => module.manifest); }
  /** Every manifest-provided operation with its provenance: `core` for construction-time (root) modules, `module` for overlays. Root is
   * the registry's own record of how the module was admitted, never read back from manifest data. */
  operations(): readonly CatalogOperation[] {
    return this.modules.flatMap(module => module.manifest.provides.operations.map(descriptor => Object.freeze({ descriptor,
      provenance: Object.freeze({ source: module.root ? 'core' as const : 'module' as const, module: `${module.manifest.module.id}@${module.manifest.module.version}` }) })));
  }
  /** Unifies the registered operations with a validated config catalog (typed `OperationCatalogError` on conflict, Core redefinition,
   * reserved target kind or unknown compensation). Config validation and the composition resolver both go through this one function. */
  catalog(configCatalog: readonly OperationDescriptor[], configTargetKinds: readonly string[]): UnifiedOperationCatalog {
    const unified = unifyOperationCatalog(this.operations(), configCatalog, configTargetKinds);
    const entries = Object.freeze([...unified.values()]);
    return Object.freeze({ entries: () => entries, async resolve(operation: OperationRef) { return unified.get(`${operation.id}@${operation.version}`)?.descriptor ?? null; } });
  }
  adapter(adapterId: string): ResolvedTargetAdapter | null { return this.adapters.get(adapterId) ?? null; }
  /** Builds the installation's targets from validated configuration; unknown adapters were already refused by config validation. */
  targets(configured: readonly ConfiguredTarget[]): EffectTargets {
    const targets = new Map<string, EffectTarget>();
    for (const entry of configured) {
      const adapter = this.adapters.get(entry.adapter);
      if (!adapter) throw new RegistryError('REGISTRY_ADAPTER_UNKNOWN');
      const target = adapter.factory.create(adapter.factory.optionsSchema.parse(entry.options));
      targets.set(target.kind, target);
    }
    return { resolve: kind => targets.get(kind) ?? null };
  }
  /** Admission keeps registry-owned state only: the manifest is the validated (deep-frozen) parse, never the registrant's object, and
   * each factory is a frozen snapshot of its `optionsSchema` and `create` taken now, so reassigning the registrant's fields after
   * sealing cannot change what a validated config resolves to (Astra 2126 R2). State closed over by `create` is not sandboxed here. */
  private admit(registration: AdapterModuleRegistration, root: boolean) {
    const manifest = admitModuleManifest(this.modules.map(module => module.manifest), registration.manifest, root);
    const declared = manifest.provides.targetAdapters.map(adapter => adapter.adapterId);
    const provided = Object.keys(registration.factories);
    if (declared.length !== provided.length || declared.some(id => typeof registration.factories[id]?.create !== 'function' || !registration.factories[id]?.optionsSchema)) {
      throw new RegistryError('REGISTRY_FACTORY_MISMATCH');
    }
    const factories = Object.freeze(Object.fromEntries(declared.map(id => [id, snapshot(registration.factories[id]!)])));
    this.modules.push(Object.freeze({ manifest, factories, root }));
    for (const adapter of manifest.provides.targetAdapters) {
      this.adapters.set(adapter.adapterId, Object.freeze({ manifest, adapterId: adapter.adapterId, version: adapter.version, factory: factories[adapter.adapterId]! }));
    }
  }
}
