import { ErrorRegistry } from '#platform/index.js';
import { RENEWABLE_SECRET_PREFIX, type SecretStoreDescriptor } from './port.js';
/** Renewable session values are reachable only through their lifecycle owner, never a generic secret reference. */
export function assertPublicSecretName(name: string): void {
  if (name.startsWith(RENEWABLE_SECRET_PREFIX)) throw ErrorRegistry.createError('SECRET_SESSION_RESERVED');
}
/** A move cannot infer personal custody or transfer a renewable grant from encryption alone. */
export function assertSecretRelocation(name: string, descriptor: SecretStoreDescriptor): void {
  assertSecretStorageProtection(name, descriptor);
  if (name.startsWith(RENEWABLE_SECRET_PREFIX)) throw ErrorRegistry.createError('SIWC_STORE_NOT_PERSONAL');
}
/** A user-confirmed downgrade cannot waive the renewable-credential storage invariant. */
export function assertSecretStorageProtection(name: string, descriptor: SecretStoreDescriptor): void {
  if (name.startsWith(RENEWABLE_SECRET_PREFIX) && descriptor.encryptedAtRest !== true)
    throw ErrorRegistry.createError('SECRET_STORE_PROTECTION_REQUIRED', { params: { backend: descriptor.id } });
}
