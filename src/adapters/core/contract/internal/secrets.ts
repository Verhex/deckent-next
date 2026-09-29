import { z } from 'zod';
import { ConfigValidationError, ErrorRegistry, installSecretResolverFactory, normalizeGlobalScopePlatform, registerConfigSection,
  resolveGlobalScopePaths, type Environment } from '#platform/index.js';
import { SECRET_STORE_ID_PATTERN, SecretStoreRegistry, type SecretStore, type SecretStoreFactory } from '#engine/index.js';
import { ENV_SECRET_STORE_ID, environmentSecretStoreFactory, fileSecretStoreFactory } from '#adapters/core/secret-store/index.js';

/**
 * The `secrets` section v1 (SECRET-K1): which registered backend resolves `$DECK:NAME` references. An absent section is the environment
 * backend (the behaviour before SECRET-K1). `store` has no schema default on purpose: the section stays absent from the default config, so
 * a healed or default-filled project file can never carry a selection that would override the installation's choice.
 */
export const secretsConfigSchema = z.object({ store: z.string().max(128).regex(SECRET_STORE_ID_PATTERN) }).strict();
export type SecretsConfig = z.infer<typeof secretsConfigSchema>;

// Core backends at construction; Enterprise/custom backends register before the section is registered (then the registry is sealed).
const registry = SecretStoreRegistry.create([environmentSecretStoreFactory, fileSecretStoreFactory]);
/** Adds a backend (an Enterprise vault, a customer KMS) without editing Core; refused after `registerProviderConfig()` sealed the registry. */
export function registerSecretStoreBackend(factory: SecretStoreFactory): void { registry.register(factory); }
export function readSecretsConfig(config: Readonly<Record<string, unknown>>): SecretsConfig {
  return config['secrets'] === undefined ? { store: ENV_SECRET_STORE_ID } : secretsConfigSchema.parse(config['secrets']);
}
/** The installation root the file backend lives in, from the caller's environment (null when none resolves). */
function installationRoot(env: Environment, platform: string): string | null {
  try { return resolveGlobalScopePaths(normalizeGlobalScopePlatform(platform, env), env).stateDir; } catch { return null; }
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
    // No `metadata` yet: its description key `config.field.secrets` is proposed in i18n-delta.json (locale files are the lead's); until then
    // the generic `config.section` description is shown.
  });
  // The one production resolver: each call opens the selected backend and reads per reference (no value cache).
  installSecretResolverFactory(context => {
    const store = openConfiguredSecretStore(context.config, context.env, context.platform);
    return name => store.get(name);
  });
  registered = true;
}
