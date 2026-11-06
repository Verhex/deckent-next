import { validateDockerSupervisorProfile, dockerTaskSilenceDeadline, dockerTaskHiddenPaths, classifyDockerTaskEffects } from '#adapters/core/docker-supervisor/index.js';
import { isNativeCliWorkerProfile, resolveNativeCliWorkerProfile, nativeCliWorkerTaskBase } from './profile.js';
import { validateNativeCliWorkerSupervisorProfile } from './supervisor.js';
import type { ExecutionProfileDefinition } from '#domain/index.js';
import type { SupervisorProfile } from '#engine/index.js';

/** Read task data through the recorded adapter. Unwrapping never selects an execution backend. */
export const executionTaskBase = (profile: ExecutionProfileDefinition) => isNativeCliWorkerProfile(profile) ? nativeCliWorkerTaskBase(resolveNativeCliWorkerProfile(profile).base) : profile;
export function validateExecutionSupervisorProfile(profile: SupervisorProfile): undefined {
  return profile.adapterId === 'native-cli-worker' ? validateNativeCliWorkerSupervisorProfile(profile) : validateDockerSupervisorProfile(profile);
}
export const executionTaskSilenceDeadline = (profile: ExecutionProfileDefinition) => dockerTaskSilenceDeadline(executionTaskBase(profile));
export const executionTaskHiddenPaths = (profile: ExecutionProfileDefinition) => dockerTaskHiddenPaths(executionTaskBase(profile));
/** Native tools are governed independently; a login realm alone does not prove workspace-only effects. */
export const executionTaskEffects = (profile: ExecutionProfileDefinition) => isNativeCliWorkerProfile(profile) ? 'unknown' as const : classifyDockerTaskEffects(profile);
