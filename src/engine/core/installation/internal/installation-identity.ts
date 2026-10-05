import type { InstallationIdentity } from '#domain/index.js';

/** Bootstrap metadata only; ownership and execution authority remain with existing contracts. */
export interface InstallationIdentityStore {
  loadOrCreate(): Promise<InstallationIdentity>;
}
export type InstallationIdentityErrorCode = 'INSTALLATION_IDENTITY_INVALID' | 'INSTALLATION_IDENTITY_UNAVAILABLE'
  | 'INSTALLATION_IDENTITY_LOCKED' | 'INSTALLATION_IDENTITY_UNSUPPORTED';
export class InstallationIdentityError extends Error {
  constructor(readonly code: InstallationIdentityErrorCode) { super(code); this.name = 'InstallationIdentityError'; }
}
