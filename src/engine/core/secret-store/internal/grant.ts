import { RegistryError } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import type { ProjectVaultAnchor, SecretGrant, SecretGrantFile } from './project.js';
import REGISTRY from './project-vault.json' with { type: 'json' };

/** `<namespace>.secret-grant.<name>@<version>`; Core owns the `core` namespace. */
export const SECRET_GRANT_STORE_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.secret-grant\.[a-z][a-z0-9-]*@[1-9][0-9]{0,5}$/u;
export const CORE_SECRET_GRANT_STORE_ID = REGISTRY.grantStore.core;
export type SecretGrantStoreErrorCode = 'SECRET_GRANT_STORE_UNSAFE' | 'SECRET_GRANT_STORE_INVALID';

/**
 * Where a project's grants live (PRE-8 v2, law audit MINOR: Enterprise replaces it through a sealed registry, like the secret store backends).
 * Core keeps `grants.json` beside the project vault. Contract for every store:
 * - `read` of a project without grants is an empty record; an unsafe or unreadable record is `SECRET_GRANT_STORE_UNSAFE`, an invalid one
 *   `SECRET_GRANT_STORE_INVALID` — callers grant nothing then (fail closed); a value never appears anywhere (grants hold names only);
 * - `update` runs read → change → publish under the store's own cross-process lock within the installation's write-lock bound; an unreadable
 *   record is never overwritten. The caller records the sealed decision first and passes its event id in the grant (no record, no grant).
 */
export interface SecretGrantStore {
  readonly id: string;
  read(): Promise<SecretGrantFile>;
  update(change: (current: SecretGrantFile) => readonly SecretGrant[]): Promise<SecretGrantFile>;
}
/** What a grant store is opened with: the installation (global) root, the project's anchor and the write lock bound (`writeLockTimeoutMs`). */
export interface SecretGrantStoreContext { readonly root: string; readonly anchor: ProjectVaultAnchor; readonly lockTimeoutMs: number }
export interface SecretGrantStoreFactory { readonly id: string; create(context: SecretGrantStoreContext): SecretGrantStore }

/** Versioned registry of grant stores: Core at construction, Enterprise/custom before `seal()`, never after (same rules as secret stores). */
export class SecretGrantStoreRegistry {
  private readonly factories = new Map<string, SecretGrantStoreFactory['create']>();
  private sealed = false;
  private constructor() {}
  static create(core: readonly SecretGrantStoreFactory[]): SecretGrantStoreRegistry {
    const registry = new SecretGrantStoreRegistry();
    for (const factory of core) registry.admit(factory, true);
    return registry;
  }
  register(factory: SecretGrantStoreFactory): void {
    if (this.sealed) throw new RegistryError('REGISTRY_SEALED');
    this.admit(factory, false);
  }
  seal(): void { this.sealed = true; }
  has(id: string): boolean { return this.factories.has(id); }
  ids(): readonly string[] { return Object.freeze([...this.factories.keys()]); }
  open(id: string, context: SecretGrantStoreContext): SecretGrantStore {
    const create = this.factories.get(id);
    if (!create) throw ErrorRegistry.createError('SECRET_GRANT_STORE_UNSAFE', { params: { reason: 'unknown-store' } });
    const store = create(context);
    if (store?.id !== id) throw new RegistryError('REGISTRY_FACTORY_MISMATCH');
    return store;
  }
  private admit(factory: SecretGrantStoreFactory, core: boolean): void {
    const id = factory?.id;
    if (typeof id !== 'string' || !SECRET_GRANT_STORE_ID_PATTERN.test(id) || typeof factory.create !== 'function') throw new RegistryError('REGISTRY_MANIFEST_INVALID');
    if (core !== id.startsWith('core.')) throw new RegistryError('REGISTRY_NAMESPACE_RESERVED');
    if (this.factories.has(id)) throw new RegistryError('REGISTRY_ADAPTER_DUPLICATE');
    const create = factory.create;
    this.factories.set(id, (context: SecretGrantStoreContext) => create.call(factory, context));
  }
}
