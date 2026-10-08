import type { Environment } from '#platform/index.js';

/**
 * SecretStore port v1 (SECRET-K1, keyring design option B). A backend keeps named secrets for one installation user; config holds only
 * `$DECK:NAME` references and every credential read resolves through the backend the installation selected. Contract for every backend:
 * - a value never appears in an error (message, params, cause), a log line, an audit record or a listing — only names do;
 * - refusals are typed `SECRET_*` codes (`SecretStoreErrorCode`), thrown as platform `DeckentError`s;
 * - `get` of an absent name is `undefined`, never a fallback to another backend;
 * - a backend that cannot write or enumerate says so in its descriptor and refuses with `SECRET_STORE_READ_ONLY` / `SECRET_STORE_UNSUPPORTED`.
 * - a bounded backend refuses a change that would leave a store it cannot read back with `SECRET_STORE_FULL`, changing nothing;
 * The port bumps only on an incompatible change of this interface.
 */
export const SECRET_STORE_PORT_VERSION = 1;
/** The `$DECK:NAME` reference grammar with a bound; `__proto__`-like names cannot match (upper case only). */
export const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const SECRET_VALUE_MAX_BYTES = 65_536;
/** `<namespace>.secret-store.<name>@<version>`; Core owns the `core` namespace. */
export const SECRET_STORE_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.secret-store\.[a-z][a-z0-9-]*@[1-9][0-9]{0,5}$/;
export type SecretStoreErrorCode = 'SECRET_NAME_INVALID' | 'SECRET_VALUE_INVALID' | 'SECRET_STORE_UNKNOWN' | 'SECRET_STORE_UNAVAILABLE'
  | 'SECRET_STORE_UNSAFE' | 'SECRET_STORE_CORRUPT' | 'SECRET_STORE_READ_ONLY' | 'SECRET_STORE_UNSUPPORTED' | 'SECRET_STORE_FULL';

export interface SecretStoreDescriptor {
  /** The registry id this store was opened under (the audit names the backend by it). */
  readonly id: string;
  readonly writable: boolean;
  readonly enumerable: boolean;
}
/** A non-throwing health view for `doctor`: whether the store could be read now, and the typed reason when not. */
export interface SecretStoreInspection {
  readonly status: 'ready' | 'unavailable' | 'unsafe' | 'corrupt';
  readonly code: SecretStoreErrorCode | null;
}
export interface SecretStore {
  readonly descriptor: SecretStoreDescriptor;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  /** True when a stored secret was removed, false when none existed. */
  delete(name: string): Promise<boolean>;
  /** Sorted names; never values. */
  listNames(): Promise<readonly string[]>;
  inspect(): Promise<SecretStoreInspection>;
}
/** What a backend is opened with: the caller's environment and platform, and the installation (global) root when one resolves. */
export interface SecretStoreContext { readonly env: Environment; readonly platform: string; readonly root: string | null }
/** One registered backend. `create` must not touch the store (opening is lazy); the store it returns must carry this `id`. */
export interface SecretStoreFactory { readonly id: string; create(context: SecretStoreContext): SecretStore }

export const isSecretName = (name: unknown): name is string => typeof name === 'string' && SECRET_NAME_PATTERN.test(name);
export const isSecretValue = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= SECRET_VALUE_MAX_BYTES;

/**
 * The installation's one consistency boundary for secret mutations (SECRET-STORE-SWITCH, Astra 2456 P1-1). Every change of a stored secret
 * and every store switch (selection read, copy, read back, publish, old-copy removal, leftover cleanup) runs inside `exclusive`, so a write can
 * never interleave with a move and be removed with the old copy. The section spans processes (several runtime services and the CLI share one
 * installation store); a wait it cannot get within its bound is the typed `SECRET_STORE_BUSY`, never a hang. Reference resolution stays
 * outside: before publication the old store holds every value, after it the new one does.
 */
export interface SecretCustody {
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  /** The installation's selected store id, read now (an absent selection is the environment backend); called inside `exclusive`. */
  selected(): Promise<string>;
}
