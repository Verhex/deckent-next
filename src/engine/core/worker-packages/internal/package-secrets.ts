import { isDeepStrictEqual } from 'node:util';
import { ENV_SECRET_STORE_ID, isSecretValue } from '#engine/core/secret-store/index.js';
import { combineKnownSecrets, getConfigKnownSecrets, knownSecretValues, type DeckentConfig } from '#platform/index.js';
import { packageRefused } from './package-activity.js';
import type { PackageKnownSecrets, PackageSecretPort, PackageSecretSnapshot } from './ports.js';

/** The scoped config selects the installation store. The environment backend has no managed registry to enumerate. */
async function readPackageSecrets(port: PackageSecretPort, config: DeckentConfig, selected: string): Promise<PackageSecretSnapshot> {
  if (port.configuredStore(config) !== selected) throw packageRefused();
  const values = new Set<string>();
  try {
    const store = port.open(config);
    if (selected !== store.descriptor.id) throw packageRefused();
    if (store.descriptor.writable && !store.descriptor.enumerable) throw packageRefused();
    if (selected !== ENV_SECRET_STORE_ID) {
      for (const name of await store.listNames()) {
        const value = await store.get(name);
        if (!isSecretValue(value)) throw packageRefused();
        values.add(value);
      }
    }
  } catch { throw packageRefused(); }
  const registered = { backend: selected, values: [...values].sort() };
  return { registered, get known(): PackageKnownSecrets {
    try {
      const known = combineKnownSecrets(getConfigKnownSecrets(config), knownSecretValues(registered.values));
      // Literal checks cover every accepted value, including unpaired UTF-16 code units.
      const needles = registered.values.map(value => ({ value, le: Buffer.from(value, 'utf16le'), be: Buffer.from(value, 'utf16le').swap16() }));
      const matchesPackageValue: NonNullable<PackageKnownSecrets['matchesPackageValue']> = (texts, bytes, checkTime) => needles.some(({ value, le, be }) => {
        checkTime?.();
        return texts.some(text => text.includes(value)) || (bytes !== undefined && (bytes.includes(le) || bytes.includes(be)));
      });
      return Object.freeze({ ...known, matchesPackageValue });
    } catch { throw packageRefused(); }
  } };
}

/** An opening scan is provisional until the caller compares its registered set at the locked handover. */
export const scanPackageSecrets = (port: PackageSecretPort, config: DeckentConfig) =>
  readPackageSecrets(port, config, port.configuredStore(config));

/** Sample a consistent store and release custody for scans. Recheck the same set at publication. */
export async function capturePackageSecrets(port: PackageSecretPort, config: DeckentConfig) {
  const read = (selected: () => Promise<string>) =>
    selected().then(id => readPackageSecrets(port, config, id)).catch(() => { throw packageRefused(); });
  const snapshot = await port.exclusive(read);
  return { known: snapshot.known, withCurrent: <T>(work: () => Promise<T>) => port.exclusive(async selected => {
    assertRegisteredPackageSecrets(snapshot.registered, await read(selected));
    return work();
  }) };
}

function assertRegisteredPackageSecrets(expected: PackageSecretSnapshot['registered'] | undefined, current: PackageSecretSnapshot) {
  if (!isDeepStrictEqual(expected, current.registered)) throw packageRefused();
}

export async function recheckPackageSecrets(port: PackageSecretPort, config: DeckentConfig, selected: () => Promise<string>,
  expected: PackageSecretSnapshot['registered'] | undefined) {
  assertRegisteredPackageSecrets(expected, await readPackageSecrets(port, config, await selected()));
}
