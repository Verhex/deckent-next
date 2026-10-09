import { loadComposedConfig } from '#composition/core/root/index.js';
import { assertActorAssurance, principalToActor, resolveLocalOsPrincipal, type ConfigLoadOptions } from '#platform/index.js';
import { openConfiguredSecretStore, openRegisteredSecretStore, readSecretsConfig, registeredSecretStores } from '#adapters/index.js';
import { inspectSecretEnvironmentGuard, isSecretName, missingSecretReferenceNames, type SecretStore, type SecretStoreInspection } from '#engine/index.js';

/** `doctor`'s secret store line (SECRET-K1, owner S1): which backend this installation uses and whether it can be read now. */
export interface SecretStoreInspectionView extends SecretStoreInspection {
  readonly schemaVersion: 1; readonly backend: string; readonly writable: boolean; readonly enumerable: boolean;
  /** Present when another Core store holds names (`entries`) or could not be listed now (`unverified`). */
  readonly envGuard?: Readonly<Record<string, Readonly<{ names: readonly string[]; code: string | null }>>>;
  readonly leftover?: Readonly<{ backends: readonly string[]; entries: number; unverified: readonly string[] }>;
}
export interface SecretNamesView { readonly schemaVersion: 1; readonly backend: string; readonly names: readonly string[] }

/** Read the selection without resolving any secret value. */
async function selectedStore(projectRoot: string, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(projectRoot, { ...options, force: true, heal: false, secretResolver: async () => undefined, onWarning: () => {} });
  return { config, store: openConfiguredSecretStore(config, options.env ?? process.env, options.platform) };
}
/** Never throws for the store's own state: an unsafe, corrupt or unavailable store is reported with its typed code. */
export async function inspectConfiguredSecretStore(projectRoot: string, options: ConfigLoadOptions = {}): Promise<SecretStoreInspectionView> {
  const { store } = await selectedStore(projectRoot, options), health = await store.inspect();
  const leftover = await leftoverEntries(store.descriptor.id, options);
  return Object.freeze({ schemaVersion: 1, backend: store.descriptor.id, writable: store.descriptor.writable, enumerable: store.descriptor.enumerable, ...health,
    ...(store.descriptor.id === 'core.secret-store.env@1' ? { envGuard: await environmentGuard(projectRoot, options) } : {}),
    ...(leftover.entries || leftover.unverified.length ? { leftover } : {}) });
}
/** Other-store names are counted without values; unlistable stores remain unverified (Astra 2456 N2). */
async function leftoverEntries(selected: string, options: ConfigLoadOptions) {
  const env = options.env ?? process.env, backends: string[] = [], unverified: string[] = []; let entries = 0;
  for (const id of registeredSecretStores()) {
    if (id === selected || !id.startsWith('core.')) continue;
    const other = openRegisteredSecretStore(id, env, options.platform);
    if (!other.descriptor.enumerable) continue;
    const count = await other.listNames().then(names => names.length, () => null);
    if (count === null) unverified.push(id);
    else if (count) { backends.push(id); entries += count; }
  }
  return Object.freeze({ backends: Object.freeze(backends), entries, unverified: Object.freeze(unverified) });
}
/** Names only, never values. A backend that cannot enumerate (the environment) refuses with `SECRET_STORE_UNSUPPORTED`. */
export async function listConfiguredSecretNames(projectRoot: string, options: ConfigLoadOptions = {}): Promise<SecretNamesView> {
  const { config, store } = await selectedStore(projectRoot, options);
  // The local OS person reads the names of their own installation store; the installation's assurance setting applies (as for doctor).
  assertActorAssurance(principalToActor(resolveLocalOsPrincipal('cli')), 'secret-list', config.enforce_principal_assurance);
  return Object.freeze({ schemaVersion: 1, backend: store.descriptor.id, names: await store.listNames() });
}

/** SECRET-STORE-SWITCH picker: the registered stores and the installation's selection (store ids only; nothing is resolved or read from a store). */
export async function listConfiguredSecretStores(projectRoot: string, options: ConfigLoadOptions = {}) {
  const { config } = await selectedStore(projectRoot, options);
  return Object.freeze({ schemaVersion: 1 as const, current: readSecretsConfig(config).store, stores: registeredSecretStores(),
    ...(readSecretsConfig(config).store === 'core.secret-store.env@1' ? { envGuard: await environmentGuard(projectRoot, options) } : {}) });
}

async function environmentGuard(root: string, options: ConfigLoadOptions) {
  return inspectSecretEnvironmentGuard(await configuredEnvironmentReferenceNames(root, options), registeredSecretStores()
    .filter(id => id !== 'core.secret-store.env@1').map(id => openRegisteredSecretStore(id, options.env ?? process.env, options.platform)));
}
/** Collect unresolved config reference names; a forced read avoids the effective-config cache. */
export async function configuredEnvironmentReferenceNames(root: string, options: ConfigLoadOptions): Promise<readonly string[]> {
  const names = new Set<string>(), env = options.env ?? process.env;
  await loadComposedConfig(root, { ...options, force: true, heal: false, onWarning: () => {}, secretResolver: async name => {
    if (isSecretName(name) && Object.hasOwn(env, name) && typeof env[name] === 'string' && env[name] !== '') names.add(name);
    return undefined; } });
  return Object.freeze([...names].sort());
}
export async function missingEnvironmentReferenceNames(root: string, options: ConfigLoadOptions, target: SecretStore) {
  return missingSecretReferenceNames(await configuredEnvironmentReferenceNames(root, options), target); }
