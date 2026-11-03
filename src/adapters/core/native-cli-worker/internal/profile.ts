import type { ExecutionProfileDefinition } from '#domain/index.js';
import { nativeCliWorkerParameters, nativeCliWorkerProfile, NativeCliWorkerError, type NativeCliWorkerBinding } from '#capabilities/index.js';
import { resolveDockerTaskProfile } from '#adapters/core/docker-supervisor/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
export { NATIVE_CLI_WORKER_ADAPTER, nativeCliWorkerBindingSchema, isNativeCliWorkerProfile, NativeCliWorkerError, type NativeCliWorkerBinding } from '#capabilities/index.js';

/** Base is immutable task data, never an execution alternative. */
export function resolveNativeCliWorkerProfile(input: ExecutionProfileDefinition) {
  const { base, binding } = nativeCliWorkerParameters(input), task = resolveDockerTaskProfile(base), entry = nativeCliAgent(binding.protocolFamily);
  if (!entry || task.siwcWorker || task.nativeSubscription?.provider !== entry.id || task.nativeSubscription.schemaVersion !== 2
    || !task.nativeSubscription.promptDelivery || !task.nativeSubscription.model || task.nativeSubscription.model.auxiliaryModelIds.length
    || task.nativeSubscription.preflight?.discovery !== 'disabled') throw new NativeCliWorkerError('NATIVE_CLI_WORKER_PROFILE_INVALID');
  return Object.freeze({ base, binding, entry, ...task });
}
export function createNativeCliWorkerProfile(base: ExecutionProfileDefinition, binding: NativeCliWorkerBinding): ExecutionProfileDefinition {
  const profile = nativeCliWorkerProfile(base, binding); resolveNativeCliWorkerProfile(profile); return profile;
}
