import type { InstallationIdentity, InstallationBinding, InstallationIdentityChoice, InstallationIdentityResolution } from '#domain/index.js';

/** Bootstrap metadata only; ownership and execution authority remain with existing contracts. */
export interface InstallationIdentityStore {
  loadOrCreate(): Promise<InstallationIdentity>;
  resolveRelocation(choice: InstallationIdentityChoice, principal: { readonly issuer: string; readonly subject: string }): Promise<InstallationIdentityResolution>;
}
export interface InstallationBindingSource { capture(): Promise<InstallationBinding> }
export type InstallationIdentityErrorCode = 'INSTALLATION_IDENTITY_INVALID' | 'INSTALLATION_IDENTITY_UNAVAILABLE'
  | 'INSTALLATION_IDENTITY_LOCKED' | 'INSTALLATION_IDENTITY_UNSUPPORTED' | 'INSTALLATION_IDENTITY_RELOCATED'
  | 'INSTALLATION_IDENTITY_RESOLUTION_INVALID';
export class InstallationIdentityError extends Error {
  constructor(readonly code: InstallationIdentityErrorCode) { super(code); this.name = 'InstallationIdentityError'; }
}
