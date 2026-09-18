import type { VerifiedPrincipal } from '#domain/index.js';
import type { DispatchClaim, DispatchStore, SupervisorProfile, SupervisorProfileValidator } from '#engine/index.js';
import { validateDockerSupervisorProfile } from '#adapters/index.js';

export const custodyProfile: SupervisorProfile = Object.freeze({
  schemaVersion: 1,
  adapterId: 'test-supervisor',
  adapterVersion: 1,
  parameters: Object.freeze({ fixture: 'strict-custody-profile' }),
});

export const custodyProfiles: SupervisorProfileValidator = Object.freeze({
  async validate(profile) {
    if (JSON.stringify(profile) !== JSON.stringify(custodyProfile)) throw new Error('TEST_SUPERVISOR_PROFILE_INVALID');
  },
});

export const custodyOrDockerProfiles: SupervisorProfileValidator = Object.freeze({
  async validate(profile) {
    if (profile.adapterId === custodyProfile.adapterId) return custodyProfiles.validate(profile);
    if (profile.adapterId === 'docker') return validateDockerSupervisorProfile(profile);
    throw new Error('TEST_SUPERVISOR_PROFILE_INVALID');
  },
});

export const custodyPrincipal: VerifiedPrincipal = Object.freeze({
  id: 'test-launcher', issuer: 'test', subject: 'fixture', assurance: 'os-user', scopeIds: Object.freeze(['s', 'other']),
});

export function dispatchAdmission(claim: DispatchClaim) { return Object.freeze({ ...claim, profile: custodyProfile }); }

export async function grantTestLaunch(store: Pick<DispatchStore, 'grantLaunch'>, claim: DispatchClaim, now = 1) {
  return store.grantLaunch({ claim, principal: custodyPrincipal, now });
}
