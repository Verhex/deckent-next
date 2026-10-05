import type { InstallationIdentity, InstallationBinding, InstallationIdentityChoice, InstallationIdentityResolution } from '#domain/index.js';

import type { IdentityRead } from './project-identity.js';

export type InstallationBindingCapability = InstallationBinding | { readonly status: 'unsupported' };
export type InstallationIdentityRead = IdentityRead<InstallationIdentity> & { readonly bindingCapability: 'supported' | 'unsupported' | 'not-observed' };

/** Bootstrap metadata only; ownership and execution authority remain with existing contracts. */
export interface InstallationIdentityStore {
  read(): Promise<InstallationIdentityRead>;
  loadOrCreate(): Promise<InstallationIdentity>;
  resolveRelocation(choice: InstallationIdentityChoice, principal: { readonly issuer: string; readonly subject: string }): Promise<InstallationIdentityResolution>;
}
export interface InstallationBindingSource { capture(): Promise<InstallationBindingCapability> }
export type InstallationIdentityErrorCode = 'INSTALLATION_IDENTITY_INVALID' | 'INSTALLATION_IDENTITY_UNAVAILABLE'
  | 'INSTALLATION_IDENTITY_LOCKED' | 'INSTALLATION_IDENTITY_UNSUPPORTED' | 'INSTALLATION_IDENTITY_RELOCATED'
  | 'INSTALLATION_IDENTITY_RESOLUTION_INVALID';
export class InstallationIdentityError extends Error {
  constructor(readonly code: InstallationIdentityErrorCode) { super(code); this.name = 'InstallationIdentityError'; }
}
