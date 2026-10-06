import type { InstallationIdentity, InstallationBinding, InstallationBindingV2, InstallationBindingSourceKind, InstallationBindingStrength,
  InstallationIdentityChoice, InstallationIdentityResolution } from '#domain/index.js';

import type { IdentityRead } from './project-identity.js';

/** What this host can bind now. Posix hosts reach at least `weak`; `unsupported` remains for a host without any binding mechanism. */
export type InstallationBindingCapability = InstallationBindingV2 | { readonly status: 'unsupported' };
/** Additive read observation: strength and source kind of the current capture, never a machine value or digest. */
export interface InstallationBindingObservation { readonly strength: InstallationBindingStrength; readonly source: InstallationBindingSourceKind }
export type InstallationIdentityRead = IdentityRead<InstallationIdentity> & {
  readonly bindingCapability: 'supported' | 'unsupported' | 'not-observed';
  readonly binding?: InstallationBindingObservation;
  /** The next installation-bound write must take the store's write path (bind, strengthen or refuse). Reads never act on it. */
  readonly pendingWrite?: true;
};

/** Bootstrap metadata only; ownership and execution authority remain with existing contracts. */
export interface InstallationIdentityStore {
  read(): Promise<InstallationIdentityRead>;
  loadOrCreate(): Promise<InstallationIdentity>;
  resolveRelocation(choice: InstallationIdentityChoice, principal: { readonly issuer: string; readonly subject: string }): Promise<InstallationIdentityResolution>;
}
export interface InstallationBindingSource { capture(): Promise<InstallationBindingCapability> }
export type InstallationIdentityErrorCode = 'INSTALLATION_IDENTITY_INVALID' | 'INSTALLATION_IDENTITY_UNAVAILABLE'
  | 'INSTALLATION_IDENTITY_LOCKED' | 'INSTALLATION_IDENTITY_UNSUPPORTED' | 'INSTALLATION_IDENTITY_RELOCATED'
  | 'INSTALLATION_IDENTITY_RESOLUTION_INVALID' | 'INSTALLATION_IDENTITY_SOURCE_INVALID' | 'INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED';
export class InstallationIdentityError extends Error {
  constructor(readonly code: InstallationIdentityErrorCode) { super(code); this.name = 'InstallationIdentityError'; }
}

/**
 * Pure comparison of a retained binding with the current capture; every store path uses it.
 * - `match`: same evidence at the recorded strength; nothing to write.
 * - `strengthen`: a weak record whose root, device and inode match a machine-strength capture; the write path records machine strength.
 * - `relocated`: another machine digest, another location, or a machine-strength record now captured only weakly (machine identity gone,
 *   or copied onto a host without one). Resolution stays the explicit `--keep` / `--new` choice.
 */
export type InstallationBindingAssessment = 'match' | 'strengthen' | 'relocated';
export function assessInstallationBinding(recorded: InstallationBinding, captured: InstallationBindingV2): InstallationBindingAssessment {
  if (recorded.canonicalRoot !== captured.canonicalRoot || recorded.device !== captured.device || recorded.inode !== captured.inode) return 'relocated';
  if (recorded.schemaVersion === 2 && recorded.strength === 'weak') return captured.strength === 'machine' ? 'strengthen' : 'match';
  if (captured.strength !== 'machine') return 'relocated';
  return recorded.machineDigest === captured.machineDigest ? 'match' : 'relocated';
}
