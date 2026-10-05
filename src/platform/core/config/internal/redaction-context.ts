import { EMPTY_KNOWN_SECRETS, type KnownSecretSnapshot } from '#platform/core/redaction/index.js';

// Ephemeral provenance of the config already resolved for one load, never part of effective config or a second secret store.
const known = new WeakMap<object, KnownSecretSnapshot>();
export function bindConfigKnownSecrets(config: object, snapshot: KnownSecretSnapshot): void { known.set(config, snapshot); }
export function getConfigKnownSecrets(config: object): KnownSecretSnapshot { return known.get(config) ?? EMPTY_KNOWN_SECRETS; }
