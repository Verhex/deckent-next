import { installationIdentitySchema, type InstallationIdentity } from '#domain/index.js';
import { beuserBindingSchema, type BeuserBinding } from '#domain/core/beuser/index.js';
import { sha256 } from '#platform/index.js';

/** Versioned containment protocol path, never a caller option or an authorization credential. */
export const BEUSER_GENESIS_PATH = '/run/deckent-beuser/genesis.json';
export type BeuserRealmSeal = NonNullable<InstallationIdentity['realmSeal']>;
export function beuserBindingDigest(binding: BeuserBinding): string {
  return sha256(JSON.stringify(beuserBindingSchema.parse(binding)));
}
export function createBeuserRealmSeal(binding: BeuserBinding): BeuserRealmSeal {
  const pinned = beuserBindingSchema.parse(binding);
  return Object.freeze({ fixture: 'realm-sealed', schemaVersion: 1, realmId: pinned.realmId,
    nonce: pinned.nonce, bindingDigest: beuserBindingDigest(pinned) });
}
export function parseBeuserRealmSeal(value: unknown): BeuserRealmSeal {
  // Use the durable identity schema so a malformed/extended seal never silently becomes an ordinary identity.
  return installationIdentitySchema.parse({ schemaVersion: 1, installationId: value && typeof value === 'object' && 'nonce' in value ? value.nonce : undefined, realmSeal: value }).realmSeal!;
}
export class BeuserTransferError extends Error {
  readonly code = 'BACKUP_REALM_SEALED';
  constructor() { super('BACKUP_REALM_SEALED'); this.name = 'BeuserTransferError'; }
}
/** One-way refusal only: even a forged, null or malformed marker refuses; it never grants sandbox authority. */
export function assertUnsealedInstallation(record: unknown): void {
  if (record && typeof record === 'object' && ('realmSeal' in record || 'fixture' in record || 'schemaVersion' in record && record.schemaVersion === 3)) {
    throw new BeuserTransferError();
  }
}
