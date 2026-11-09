import { RegistryError } from '#domain/index.js';
import { AdapterRegistry, CORE_SECRET_GRANT_STORE_ID, SecretGrantStoreRegistry, SecretStoreRegistry, type AdapterModuleRegistration, type SecretGrantStore, type SecretGrantStoreContext,
  type SecretGrantStoreFactory, type SecretStoreFactory } from '#engine/index.js';
import { httpConditionalAdapterModule } from '#adapters/core/http-conditional-effect/index.js';
import { encryptedFileSecretStoreFactory, environmentSecretStoreFactory, fileSecretGrantStoreFactory, fileSecretStoreFactory } from '#adapters/core/secret-store/index.js';
import { coreHostShellModule, coreMcpToolCallModule, coreNetworkFetchModule, corePolicyAdministerModule, coreScratchWriteModule, coreWorkspaceWriteModule } from './core-operations.js';

// The process-wide adapter registries `deckent/extensions` feeds. Core entries are passed at construction (owner A20); other packages
// register until `sealExtensionRegistries` (composeCore only), so a configuration validated against them never changes meaning afterwards.
const operations = AdapterRegistry.create([httpConditionalAdapterModule, coreWorkspaceWriteModule, coreHostShellModule, coreScratchWriteModule, coreNetworkFetchModule,
  corePolicyAdministerModule, coreMcpToolCallModule]);
const stores = SecretStoreRegistry.create([environmentSecretStoreFactory, fileSecretStoreFactory, encryptedFileSecretStoreFactory]);
// PRE-8 v2: Core keeps project grants beside the project vault; one non-Core store may replace it.
const grants = SecretGrantStoreRegistry.create([fileSecretGrantStoreFactory]);

export function registerOperationAdapterModule(registration: AdapterModuleRegistration): void { operations.register(registration); }
/** Adds a backend (an Enterprise vault, a customer KMS) without editing Core. */
export function registerSecretStoreBackend(factory: SecretStoreFactory): void { stores.register(factory); }
export function registerSecretGrantStore(factory: SecretGrantStoreFactory): void {
  if (grants.ids().some(id => id !== CORE_SECRET_GRANT_STORE_ID)) throw new RegistryError('REGISTRY_ADAPTER_DUPLICATE');
  grants.register(factory);
}
/** Closes these registries in the order composeCore always sealed them (operations, secret stores, grant stores); idempotent. */
export function sealExtensionRegistries(): void { operations.seal(); stores.seal(); grants.seal(); }

// Read-only views for the configuration sections: nothing outside this unit registers or seals.
export const operationAdapters: Pick<AdapterRegistry, 'catalog' | 'targetOptions' | 'targets'> = Object.freeze({
  catalog: operations.catalog.bind(operations), targetOptions: operations.targetOptions.bind(operations), targets: operations.targets.bind(operations) });
export const secretStores: Pick<SecretStoreRegistry, 'has' | 'ids' | 'open'> = Object.freeze({ has: stores.has.bind(stores), ids: stores.ids.bind(stores), open: stores.open.bind(stores) });
/** The project's grant store: the registered non-Core store when there is one, else Core's file. */
export function openSelectedSecretGrantStore(context: SecretGrantStoreContext): SecretGrantStore {
  return grants.open(grants.ids().find(id => id !== CORE_SECRET_GRANT_STORE_ID) ?? CORE_SECRET_GRANT_STORE_ID, context);
}
