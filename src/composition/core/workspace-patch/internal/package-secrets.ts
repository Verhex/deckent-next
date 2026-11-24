import { createInstallationSecretCustody, openConfiguredSecretStore } from '#adapters/index.js';
import { ENV_SECRET_STORE_ID } from '#engine/index.js';
import { combineKnownSecrets, getConfigKnownSecrets, knownSecretValues, type ConfigLoadOptions, type DeckentConfig } from '#platform/index.js';
import { packageRefused } from './package-activity.js';

/** The scoped config selects the installation store. The environment backend has no managed registry to enumerate. */
export async function readPackageSecrets(config: DeckentConfig, options: ConfigLoadOptions, selected?: string) {
  const store = openConfiguredSecretStore(config, options.env ?? process.env, options.platform ?? process.platform);
  const backend = store.descriptor.id, values = new Set<string>();
  if (selected !== undefined && selected !== backend) throw packageRefused();
  if (backend !== ENV_SECRET_STORE_ID) {
    for (const name of await store.listNames()) {
      const value = await store.get(name);
      if (value === undefined) throw packageRefused();
      values.add(value);
    }
  }
  const registered = { backend, values: [...values].sort() };
  return { registered, get known() { return combineKnownSecrets(getConfigKnownSecrets(config), knownSecretValues(registered.values)); } };
}

export function withPackageSecretCustody<T>(options: ConfigLoadOptions, work: (custody: ReturnType<typeof createInstallationSecretCustody>) => Promise<T>) {
  const custody = createInstallationSecretCustody(options.env ?? process.env, options.platform ?? process.platform);
  return custody.exclusive(() => work(custody));
}
