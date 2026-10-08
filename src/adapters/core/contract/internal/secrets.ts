import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { CONFIG_CONTRACT_SINCE, ConfigValidationError, DeckentError, ErrorRegistry, installSecretResolverFactory, isRecord, normalizeGlobalScopePlatform, readJsonFile,
  registerConfigSection, resolveGlobalConfigPaths, resolveGlobalScopePaths, withConfigWriteLock, writeConfig, type Environment } from '#platform/index.js';
import { SECRET_STORE_ID_PATTERN, SecretStoreRegistry, type SecretCustody, type SecretStore, type SecretStoreFactory, type SecretStoreSelectionPort } from '#engine/index.js';
import { ENV_SECRET_STORE_ID, encryptedFileSecretStoreFactory, environmentSecretStoreFactory, fileSecretStoreFactory } from '#adapters/core/secret-store/index.js';

/**
 * The `secrets` section v1 (SECRET-K1): which registered backend resolves `$DECK:NAME` references. An absent section is the environment
 * backend (the behaviour before SECRET-K1). `store` has no schema default on purpose: the section stays absent from the default config, so
 * a healed or default-filled project file can never carry a selection that would override the installation's choice.
 */
export const secretsConfigSchema = z.object({ store: z.string().max(128).regex(SECRET_STORE_ID_PATTERN) }).strict();
export type SecretsConfig = z.infer<typeof secretsConfigSchema>;

// Core backends at construction; Enterprise/custom backends register before the section is registered (then the registry is sealed).
const registry = SecretStoreRegistry.create([environmentSecretStoreFactory, fileSecretStoreFactory, encryptedFileSecretStoreFactory]);
/** Adds a backend (an Enterprise vault, a customer KMS) without editing Core; refused after `registerProviderConfig()` sealed the registry. */
export function registerSecretStoreBackend(factory: SecretStoreFactory): void { registry.register(factory); }
export function readSecretsConfig(config: Readonly<Record<string, unknown>>): SecretsConfig {
  return config['secrets'] === undefined ? { store: ENV_SECRET_STORE_ID } : secretsConfigSchema.parse(config['secrets']);
}
/** The installation root the file backend lives in, from the caller's environment (null when none resolves). */
function installationRoot(env: Environment, platform: string): string | null {
  try { return resolveGlobalScopePaths(normalizeGlobalScopePlatform(platform, env), env).stateDir; } catch { return null; }
}
/** Whether a backend id is registered (Core or added before the registry sealed). */
export function isRegisteredSecretStore(id: string): boolean { return registry.has(id); }
/** The registered backend ids, Core first, for a picker; never a value. */
export function registeredSecretStores(): readonly string[] { return registry.ids(); }
/** Opens one registered backend by id in the caller's environment (the store switch's source and target). */
export function openRegisteredSecretStore(id: string, env: Environment, platform: string = process.platform): SecretStore {
  return registry.open(id, { env, platform, root: installationRoot(env, platform) });
}
/**
 * SECRET-STORE-SWITCH (owner 2026-10-08): the installation's store selection, `secrets.store` of the installation (global) config. Only the
 * governed store switch publishes it — the config engine keeps refusing the secrets section (CONFIG-SURFACE) — and it publishes only on the
 * exact document it read (`expectDigest`, re-checked under the config writer lock: `CONFIG_CONCURRENT_REVISION_HOLD` otherwise). Every other
 * key of the document is kept as it was.
 */
export function createInstallationSecretStoreSelection(env: Environment, platform: string = process.platform): SecretStoreSelectionPort {
  const path = resolveGlobalConfigPaths(env, platform).platformPath;
  const read = async () => {
    const current = await readJsonFile(path);
    if (current.kind === 'io') throw ErrorRegistry.createError('CONFIG_READ_IO_HOLD', { cause: current.error });
    if (current.kind === 'absent') return { document: {} as Record<string, unknown>, digest: null };
    if (current.kind === 'corrupt' || !isRecord(current.value)) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
    return { document: current.value, digest: current.digest };
  };
  return Object.freeze({
    async read() {
      const { document, digest } = await read();
      const secrets = document['secrets'];
      return Object.freeze({ store: isRecord(secrets) && typeof secrets['store'] === 'string' ? secrets['store'] : null, digest });
    },
    async publish(store: string, expectDigest: string | null) {
      if (!registry.has(store)) throw ErrorRegistry.createError('SECRET_STORE_UNKNOWN', { params: { backend: store } });
      const { document, digest } = await read();
      if (digest !== expectDigest) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
      await writeConfig(path, { ...document, secrets: secretsConfigSchema.parse({ store }) }, expectDigest);
    },
  });
}
/** How long a secret change waits for the custody section before it is refused `SECRET_STORE_BUSY` (a switch of a full store takes far less). */
export const SECRET_CUSTODY_WAIT_MS = 5_000;
/**
 * The installation's secret custody section (Astra 2456 P1-1, Jev ddfbc6b4): the existing cross-process config writer lock on its own path
 * beside the installation config (`<config>.secret-custody.write-lock`), so every runtime service and CLI process of this installation shares
 * it and a dead owner is reclaimed as for any config lock. Lock order: custody → a store's document lock → the config document lock (the
 * selection publish); nothing takes them the other way and the paths differ, so the non-reentrant lock never nests on itself. Only a wait
 * for the section itself becomes `SECRET_STORE_BUSY`; a lock refusal inside the work keeps its own code.
 */
export function createInstallationSecretCustody(env: Environment, platform: string = process.platform, waitMs = SECRET_CUSTODY_WAIT_MS): SecretCustody {
  const path = `${resolveGlobalConfigPaths(env, platform).platformPath}.secret-custody`, selection = createInstallationSecretStoreSelection(env, platform);
  return Object.freeze({
    async exclusive<T>(work: () => Promise<T>): Promise<T> {
      let entered = false;
      // The installation directory is also the private store root: created owner-only here (the config lock alone would create it with the
      // process umask, which the file-backed stores then refuse as not private). An existing directory is left as it is.
      try { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); } catch { throw ErrorRegistry.createError('SECRET_STORE_UNAVAILABLE', { params: { backend: dirname(path) } }); }
      try { return await withConfigWriteLock(path, () => { entered = true; return work(); }, waitMs); }
      catch (error) {
        if (!entered && error instanceof DeckentError && error.code === 'CONFIG_WRITE_LOCKED') throw ErrorRegistry.createError('SECRET_STORE_BUSY');
        throw error;
      }
    },
    async selected() { return (await selection.read()).store ?? ENV_SECRET_STORE_ID; },
  });
}
/** Opens the backend the (validated, unresolved) configuration selects; opening reads nothing yet. */
export function openConfiguredSecretStore(config: Readonly<Record<string, unknown>>, env: Environment, platform: string = process.platform): SecretStore {
  return registry.open(readSecretsConfig(config).store, { env, platform, root: installationRoot(env, platform) });
}

let registered = false;
export function registerSecretStoreConfig(): void {
  if (registered) return;
  registry.seal();
  registerConfigSection('secrets', secretsConfigSchema, {
    optional: true,
    // The selection is never itself a secret reference: it is read before any reference resolves.
    secretReferences: 'forbid',
    validateValue: value => {
      if (value !== undefined && !secretsConfigSchema.safeParse(value).success) throw new ConfigValidationError([{ path: 'secrets', reason: 'SECRETS_INVALID' }]);
    },
    // A project file is shared through the repository: it may not redirect where this installation's credentials are read from.
    validateLayers: (_global, project) => {
      if (project !== undefined) throw new ConfigValidationError([{ path: 'secrets', reason: 'SECRETS_PROJECT_LAYER_FORBIDDEN' }]);
    },
    validateEffective: config => {
      const store = readSecretsConfig(config).store;
      if (!registry.has(store)) throw ErrorRegistry.createError('SECRET_STORE_UNKNOWN', { params: { backend: store } });
    },
    metadata: { descriptionKey: 'config.field.secrets', tier: 'core', since: CONFIG_CONTRACT_SINCE, binding: { state: 'bound', consumers: ['src/adapters/core/contract'] }, apply: 'restart' },
  });
  // The one production resolver: each call opens the selected backend and reads per reference (no value cache).
  installSecretResolverFactory(context => {
    const store = openConfiguredSecretStore(context.config, context.env, context.platform);
    return name => store.get(name);
  });
  registered = true;
}
