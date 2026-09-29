import { RegistryError } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { SECRET_STORE_ID_PATTERN, type SecretStore, type SecretStoreContext, type SecretStoreFactory } from './port.js';

const CORE_PREFIX = 'core.';
/**
 * Versioned registry of secret store backends (SECRET-K1). Core backends are passed at construction and are the only ids in the `core.`
 * namespace; Enterprise/custom backends (`enterprise.secret-store.vault@1`, …) register afterwards without editing Core, until `seal()`
 * — called once the configuration section that selects a backend is registered, so a validated selection never changes meaning.
 * Registration grants nothing: which backend is used is the installation's configuration, who may change a secret is policy.
 */
export class SecretStoreRegistry {
  private readonly factories = new Map<string, SecretStoreFactory>();
  private sealed = false;
  private constructor() {}
  static create(core: readonly SecretStoreFactory[]): SecretStoreRegistry {
    const registry = new SecretStoreRegistry();
    for (const factory of core) registry.admit(factory, true);
    return registry;
  }
  register(factory: SecretStoreFactory): void {
    if (this.sealed) throw new RegistryError('REGISTRY_SEALED');
    this.admit(factory, false);
  }
  seal(): void { this.sealed = true; }
  has(id: string): boolean { return this.factories.has(id); }
  ids(): readonly string[] { return Object.freeze([...this.factories.keys()]); }
  /** Opens the selected backend (lazy: nothing is read yet). Unknown ids are the typed `SECRET_STORE_UNKNOWN`. */
  open(id: string, context: SecretStoreContext): SecretStore {
    const factory = this.factories.get(id);
    if (!factory) throw ErrorRegistry.createError('SECRET_STORE_UNKNOWN', { params: { backend: id } });
    const store = factory.create(context);
    // The audit and doctor name the backend by the registry's id; a store claiming another identity is refused.
    if (store?.descriptor?.id !== id) throw new RegistryError('REGISTRY_FACTORY_MISMATCH');
    return store;
  }
  private admit(factory: SecretStoreFactory, core: boolean): void {
    const id = factory?.id;
    if (typeof id !== 'string' || !SECRET_STORE_ID_PATTERN.test(id) || typeof factory.create !== 'function') throw new RegistryError('REGISTRY_MANIFEST_INVALID');
    if (core !== id.startsWith(CORE_PREFIX)) throw new RegistryError('REGISTRY_NAMESPACE_RESERVED');
    if (this.factories.has(id)) throw new RegistryError('REGISTRY_ADAPTER_DUPLICATE');
    // Snapshot the function now: reassigning the registrant's field later changes nothing (the A04 registry rule).
    const create = factory.create;
    this.factories.set(id, Object.freeze({ id, create: (context: SecretStoreContext) => create.call(factory, context) }));
  }
}
