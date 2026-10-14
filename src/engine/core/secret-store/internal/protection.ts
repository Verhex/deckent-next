import { ErrorRegistry } from '#platform/index.js';
import { RENEWABLE_SECRET_PREFIX, type SecretStoreDescriptor } from './port.js';
/** A user-confirmed downgrade cannot waive the renewable-credential storage invariant. */
export function assertSecretStorageProtection(name: string, descriptor: SecretStoreDescriptor): void {
  if (name.startsWith(RENEWABLE_SECRET_PREFIX) && descriptor.encryptedAtRest !== true)
    throw ErrorRegistry.createError('SECRET_STORE_PROTECTION_REQUIRED', { params: { backend: descriptor.id } });
}
