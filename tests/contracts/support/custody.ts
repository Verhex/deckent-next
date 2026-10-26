import { arch, hostname, platform, userInfo } from 'node:os';
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
  validate(profile: SupervisorProfile) {
    if (JSON.stringify(profile) !== JSON.stringify(custodyProfile)) throw new Error('TEST_SUPERVISOR_PROFILE_INVALID');
    return undefined;
  },
});

export const custodyOrDockerProfiles: SupervisorProfileValidator = Object.freeze({
  validate(profile: SupervisorProfile) {
    if (profile.adapterId === custodyProfile.adapterId) return custodyProfiles.validate(profile);
    if (profile.adapterId === 'docker') return validateDockerSupervisorProfile(profile);
    throw new Error('TEST_SUPERVISOR_PROFILE_INVALID');
  },
});

export const custodyPrincipal: VerifiedPrincipal = Object.freeze({
  id: 'test-launcher', issuer: 'test', subject: 'fixture', assurance: 'os-user', scopeIds: Object.freeze(['s', 'other']),
});

export function dispatchAdmission(claim: DispatchClaim, profile: SupervisorProfile = custodyProfile) { return Object.freeze({ ...claim, profile }); }
/** A Docker dispatch profile of this host as the adapter records it: v3 with today's isolation block, or v2 as recorded before alpha.56 (no block). */
export function dockerDispatchProfile(adapterVersion: 2 | 3 = 3): SupervisorProfile {
  const user = userInfo();
  return Object.freeze({ schemaVersion: 1, adapterId: 'docker', adapterVersion, parameters: { endpoint: 'unix:///var/run/docker.sock',
    options: { executable: '/usr/bin/docker', imageId: 'sha256:' + 'a'.repeat(64), workspaceRoot: '/tmp/fixture-workspaces', uid: 1000, gid: 1000, memoryBytes: 268435456, pids: 64, cpus: 1,
      logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 },
    origin: { hostname: hostname(), platform: platform(), architecture: arch(), uid: user.uid, gid: user.gid, daemonId: 'fixture-daemon' },
    ...(adapterVersion === 3 ? { isolation: { schemaVersion: 1, network: 'none', egress: { kind: 'none' } } } : {}) } });
}

export async function grantTestLaunch(store: Pick<DispatchStore, 'grantLaunch'>, claim: DispatchClaim, now = 1) {
  return store.grantLaunch({ claim, principal: custodyPrincipal, now });
}
