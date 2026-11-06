import type { ExecutionProfileDefinition } from '#domain/index.js';
import { nativeCliWorkerParameters, nativeCliWorkerProfile, NativeCliWorkerError, type NativeCliWorkerBinding } from '#capabilities/index.js';
import { resolveDockerTaskProfile } from '#adapters/core/docker-supervisor/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
export { NATIVE_CLI_WORKER_ADAPTER, nativeCliWorkerBindingSchema, isNativeCliWorkerProfile, NativeCliWorkerError, type NativeCliWorkerBinding } from '#capabilities/index.js';

/** R8b (owner D1b): a CLI worker runs in the host sandbox, never an image, so its base may omit `imageId`; the Docker task validators (which keep
 * it required) read such a base with this fixed placeholder. The one place the optional image lives; the placeholder never reaches a stored profile. */
const NO_IMAGE = `sha256:${'0'.repeat(64)}`;
export const nativeCliWorkerTaskBase = (base: ExecutionProfileDefinition): ExecutionProfileDefinition => 'imageId' in base.parameters ? base : { ...base, parameters: { ...base.parameters, imageId: NO_IMAGE } };
export function nativeCliWorkerStoredBase(base: ExecutionProfileDefinition): ExecutionProfileDefinition {
  if (base.parameters['imageId'] !== NO_IMAGE) return base; const { imageId, ...parameters } = base.parameters; void imageId; return { ...base, parameters };
}
/** Base is immutable task data, never an execution alternative. */
export function resolveNativeCliWorkerProfile(input: ExecutionProfileDefinition) {
  const { base, binding } = nativeCliWorkerParameters(input), task = resolveDockerTaskProfile(nativeCliWorkerTaskBase(base)), entry = nativeCliAgent(binding.protocolFamily);
  if (!entry || task.siwcWorker || task.nativeSubscription?.provider !== entry.id || task.nativeSubscription.schemaVersion !== 2
    || !task.nativeSubscription.promptDelivery || !task.nativeSubscription.model || task.nativeSubscription.model.auxiliaryModelIds.length
    || task.nativeSubscription.preflight?.discovery !== 'disabled') throw new NativeCliWorkerError('NATIVE_CLI_WORKER_PROFILE_INVALID');
  return Object.freeze({ base, binding, entry, ...task });
}
export function createNativeCliWorkerProfile(base: ExecutionProfileDefinition, binding: NativeCliWorkerBinding): ExecutionProfileDefinition {
  const profile = nativeCliWorkerProfile(base, binding); resolveNativeCliWorkerProfile(profile); return profile;
}
