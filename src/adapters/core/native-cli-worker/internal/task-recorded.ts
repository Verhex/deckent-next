import { DockerSupervisor, recordedDockerSupervisor, dockerProfileObservesWorker } from '#adapters/core/docker-supervisor/index.js';
import { recordedNativeCliWorkerSupervisor } from './recorded.js';
import { validateNativeCliWorkerSupervisorProfile } from './supervisor.js';
import type { SandboxRequest, SupervisorProfile } from '#engine/index.js';

/** Only the recorded adapter identity selects management. No Docker fallback for a native profile/version. */
export function recordedTaskSupervisor(profile: SupervisorProfile) {
  return profile.adapterId === 'native-cli-worker' ? recordedNativeCliWorkerSupervisor(profile) : recordedDockerSupervisor(profile);
}
export async function inspectRecordedTaskActivity(profile: SupervisorProfile, request: SandboxRequest) {
  return profile.adapterId === 'native-cli-worker' ? recordedNativeCliWorkerSupervisor(profile).inspectActivity(request)
    : (await DockerSupervisor.restoreProfile(profile)).inspectActivity(request);
}
export function taskProfileObservesWorker(profile: SupervisorProfile) {
  if (profile.adapterId === 'native-cli-worker') { validateNativeCliWorkerSupervisorProfile(profile); return true; }
  return dockerProfileObservesWorker(profile);
}
