import { loadComposedConfig } from '#composition/core/root/index.js';
import { assertActorAssurance, principalToActor, resolveLocalOsPrincipal, type ConfigLoadOptions } from '#platform/index.js';
import { openConfiguredSecretStore } from '#adapters/index.js';
import type { SecretStoreInspection } from '#engine/index.js';

/** `doctor`'s secret store line (SECRET-K1, owner S1): which backend this installation uses and whether it can be read now. */
export interface SecretStoreInspectionView extends SecretStoreInspection {
  readonly schemaVersion: 1; readonly backend: string; readonly writable: boolean; readonly enumerable: boolean;
}
export interface SecretNamesView { readonly schemaVersion: 1; readonly backend: string; readonly names: readonly string[] }

/** The selection only: the configuration is read without resolving any reference (no value is read for a report about the store itself). */
async function selectedStore(projectRoot: string, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(projectRoot, { ...options, heal: false, secretResolver: async () => undefined, onWarning: () => {} });
  return { config, store: openConfiguredSecretStore(config, options.env ?? process.env, options.platform) };
}
/** Never throws for the store's own state: an unsafe, corrupt or unavailable store is reported with its typed code. */
export async function inspectConfiguredSecretStore(projectRoot: string, options: ConfigLoadOptions = {}): Promise<SecretStoreInspectionView> {
  const { store } = await selectedStore(projectRoot, options), health = await store.inspect();
  return Object.freeze({ schemaVersion: 1, backend: store.descriptor.id, writable: store.descriptor.writable, enumerable: store.descriptor.enumerable, ...health });
}
/** Names only, never values. A backend that cannot enumerate (the environment) refuses with `SECRET_STORE_UNSUPPORTED`. */
export async function listConfiguredSecretNames(projectRoot: string, options: ConfigLoadOptions = {}): Promise<SecretNamesView> {
  const { config, store } = await selectedStore(projectRoot, options);
  // The local OS person reads the names of their own installation store; the installation's assurance setting applies (as for doctor).
  assertActorAssurance(principalToActor(resolveLocalOsPrincipal('cli')), 'secret-list', config.enforce_principal_assurance);
  return Object.freeze({ schemaVersion: 1, backend: store.descriptor.id, names: await store.listNames() });
}
