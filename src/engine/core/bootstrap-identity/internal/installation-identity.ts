import { CodedError } from '#platform/index.js';
import { REBIND_CLASS, explicitRebindGrant, type RebindClass, type Policy } from '#domain/index.js';
import type { InstallationIdentity, InstallationBinding, InstallationBindingCapture, InstallationBindingSourceKind, InstallationBindingStrength,
  InstallationIdentityResolution } from '#domain/index.js';

import type { IdentityRead } from './project-identity.js';

/** What this host can bind now. Posix hosts reach at least `weak`; `unsupported` remains for a host without any binding mechanism. */
export type InstallationBindingCapability = InstallationBindingCapture | { readonly status: 'unsupported' };
export type RebindAdmission = { readonly class: typeof REBIND_CLASS.deviceOnly; readonly basis: 'open-class' }
  | { readonly class: typeof REBIND_CLASS.moved; readonly basis: 'human-tty' | 'macos-plain' }
  | { readonly class: typeof REBIND_CLASS.moved; readonly basis: 'ai-policy'; readonly ruleId: string; readonly policyRevision: string };
export type InstallationIdentityResolutionInput = { readonly choice: 'keep'; readonly admission: RebindAdmission } | { readonly choice: 'new' };
/** Output only. Never feed these sibling fields into the strict durable resolution record. */
export type InstallationIdentityResolutionView = InstallationIdentityResolution & { readonly class?: RebindClass | null; readonly basis?: RebindAdmission['basis']; readonly attachmentRecordsUnreconciled?: true };
/** Application seam for the bootstrap policy decision; no ledger or scope membership is involved. */
export function policyRebindAdmission(policy: Policy, principal: { readonly issuer: string; readonly subject: string }, change: RebindClass): RebindAdmission | null {
  const grant = explicitRebindGrant(policy, principal, change);
  return grant ? { class: REBIND_CLASS.moved, basis: 'ai-policy', ...grant } : null;
}
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). Additive read observation: strength and source kind of the current capture, never a machine value or digest. */
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
  /** Owned-init preflight before any persistent effect: the write path's binding rules, observed only (no identity, directory or lock). */
  admitWrite(): Promise<void>;
  resolveRelocation(input: InstallationIdentityResolutionInput, principal: { readonly issuer: string; readonly subject: string }): Promise<InstallationIdentityResolutionView>;
}
export interface InstallationBindingSource { capture(): Promise<InstallationBindingCapability> }
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). `MASKED` (B5): the record is hidden by a Deckent shell sandbox (the command runs inside one), not lost. */
export type InstallationIdentityErrorCode = 'INSTALLATION_IDENTITY_INVALID' | 'INSTALLATION_IDENTITY_UNAVAILABLE' | 'INSTALLATION_IDENTITY_MASKED'
  | 'INSTALLATION_IDENTITY_LOCKED' | 'INSTALLATION_IDENTITY_UNSUPPORTED' | 'INSTALLATION_IDENTITY_RELOCATED'
  | 'INSTALLATION_IDENTITY_RESOLUTION_INVALID' | 'INSTALLATION_IDENTITY_SOURCE_INVALID' | 'INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED'
  | 'INSTALLATION_IDENTITY_NEWER_BINDING' | 'INSTALLATION_IDENTITY_REBIND_REQUIRED';
export class InstallationIdentityError extends CodedError {
  constructor(override readonly code: InstallationIdentityErrorCode) {
    super(code, code === 'INSTALLATION_IDENTITY_REBIND_REQUIRED' ? { params: { platform: process.platform } } : {});
    this.name = 'InstallationIdentityError';
  }
}

/** Only for a relocated legacy binding. v3 reaches its existing writer fence before this classifier. */
export function classifyInstallationRebinding(recorded: InstallationBinding | null, captured: InstallationBindingCapability): RebindClass {
  return recorded && recorded.schemaVersion !== 3 && (recorded.schemaVersion === 1 || recorded.strength === 'machine')
    && !('status' in captured) && captured.strength === 'machine' && recorded.machineDigest === captured.machineDigest
    && recorded.canonicalRoot === captured.canonicalRoot && recorded.inode === captured.inode && recorded.device !== captured.device
    ? REBIND_CLASS.deviceOnly : REBIND_CLASS.moved;
}

/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17).
 * Pure comparison of a retained binding with the current capture; every store path uses it.
 * - `match`: same evidence at the recorded strength; nothing to write.
 * - `strengthen`: a weak record whose root, device and inode match a machine-strength capture; the write path records machine strength.
 * - `relocated`: another machine digest, another location, or a machine-strength record now captured only weakly (machine identity gone,
 *   or copied onto a host without one). Resolution stays the explicit `--keep` / `--new` choice.
 */
export type InstallationBindingAssessment = 'match' | 'strengthen' | 'relocated';
export function assessInstallationBinding(recorded: InstallationBinding, captured: InstallationBindingCapture): InstallationBindingAssessment {
  if (recorded.schemaVersion === 3) return captured.strength === 'machine' && recorded.machineDigest === captured.machineDigest
    && recorded.canonicalRoot === captured.canonicalRoot && recorded.inode === captured.inode
    && recorded.filesystemIdentity.kind === captured.filesystemIdentity?.kind && recorded.filesystemIdentity.value === captured.filesystemIdentity.value
    ? 'match' : 'relocated';
  if (recorded.canonicalRoot !== captured.canonicalRoot || recorded.device !== captured.device || recorded.inode !== captured.inode) return 'relocated';
  if (recorded.schemaVersion === 2 && recorded.strength === 'weak') return captured.strength === 'machine' ? 'strengthen' : 'match';
  if (captured.strength !== 'machine') return 'relocated';
  return recorded.machineDigest === captured.machineDigest ? 'match' : 'relocated';
}
