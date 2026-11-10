import { DockerSupervisor, recordedDockerSupervisor, dockerProfileObservesWorker, validateDockerSupervisorProfile, resolveDockerTaskProfile, dockerTaskSilenceDeadline,
  dockerTaskHiddenPaths, classifyDockerTaskEffects } from '#adapters/core/docker-supervisor/index.js';
import { frozenHiddenPaths, type ExecutionProfileDefinition } from '#domain/index.js';
import type { SandboxRequest, SupervisorProfile } from '#engine/index.js';
import { NATIVE_CLI_WORKER_ADAPTER, isNativeCliWorkerProfile, resolveNativeCliWorkerProfile, nativeCliWorkerTaskBase } from './profile.js';
import { recordedNativeCliWorkerSupervisor } from './recorded.js';
import { validateNativeCliWorkerSupervisorProfile } from './supervisor.js';

/** KG7 F3: one row per execution adapter, Docker the default row. Only the recorded adapter identity selects a row (no Docker fallback for a
 * native profile of another version: its own row refuses it). A connected CLI worker's base runs in the host sandbox; native tools are governed
 * independently, so a login realm alone does not prove workspace-only effects. */
const executionAdapters = {
  [NATIVE_CLI_WORKER_ADAPTER.id]: {
    validate: validateNativeCliWorkerSupervisorProfile, recorded: recordedNativeCliWorkerSupervisor,
    inspectActivity: (profile: SupervisorProfile, request: SandboxRequest) => recordedNativeCliWorkerSupervisor(profile).inspectActivity(request),
    observesWorker: (profile: SupervisorProfile) => { validateNativeCliWorkerSupervisorProfile(profile); return true; },
    task: resolveNativeCliWorkerProfile, silenceDeadline: (profile: ExecutionProfileDefinition) => resolveNativeCliWorkerProfile(profile).options.deadlineMs,
    hiddenPaths: (profile: ExecutionProfileDefinition) => frozenHiddenPaths(resolveNativeCliWorkerProfile(profile).base.parameters), effects: () => 'unknown' as const },
  default: {
    validate: validateDockerSupervisorProfile, recorded: recordedDockerSupervisor,
    inspectActivity: async (profile: SupervisorProfile, request: SandboxRequest) => (await DockerSupervisor.restoreProfile(profile)).inspectActivity(request),
    observesWorker: dockerProfileObservesWorker,
    task: resolveDockerTaskProfile, silenceDeadline: dockerTaskSilenceDeadline, hiddenPaths: dockerTaskHiddenPaths, effects: classifyDockerTaskEffects },
};
const executionAdapter = (adapterId: string) => executionAdapters[adapterId === NATIVE_CLI_WORKER_ADAPTER.id ? NATIVE_CLI_WORKER_ADAPTER.id : 'default'];

export const validateExecutionSupervisorProfile = (profile: SupervisorProfile): undefined => executionAdapter(profile.adapterId).validate(profile);
export const recordedTaskSupervisor = (profile: SupervisorProfile) => executionAdapter(profile.adapterId).recorded(profile);
export const inspectRecordedTaskActivity = (profile: SupervisorProfile, request: SandboxRequest) => executionAdapter(profile.adapterId).inspectActivity(profile, request);
export const taskProfileObservesWorker = (profile: SupervisorProfile) => executionAdapter(profile.adapterId).observesWorker(profile);
/** The pinned task data of a frozen profile; throws when its adapter cannot resolve it. */
export const executionTask = (profile: ExecutionProfileDefinition) => executionAdapter(profile.adapter.id).task(profile);
export const executionTaskSilenceDeadline = (profile: ExecutionProfileDefinition) => executionAdapter(profile.adapter.id).silenceDeadline(profile);
export const executionTaskHiddenPaths = (profile: ExecutionProfileDefinition) => executionAdapter(profile.adapter.id).hiddenPaths(profile);
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const executionTaskEffects = (profile: ExecutionProfileDefinition) => executionAdapter(profile.adapter.id).effects(profile);
/** @deprecated B1-17: kept one release for unverified Enterprise callers; read task data through `executionTask`. */
export const executionTaskBase = (profile: ExecutionProfileDefinition) => isNativeCliWorkerProfile(profile) ? nativeCliWorkerTaskBase(resolveNativeCliWorkerProfile(profile).base) : profile;
