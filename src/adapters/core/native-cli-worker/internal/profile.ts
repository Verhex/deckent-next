import type { ExecutionProfileDefinition } from '#domain/index.js';
import { nativeCliWorkerParameters, nativeCliWorkerProfile, NativeCliWorkerError, type NativeCliWorkerBinding } from '#capabilities/index.js';
import { resolveHostSandboxTaskProfile } from '#adapters/core/docker-supervisor/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
export { NATIVE_CLI_WORKER_ADAPTER, nativeCliWorkerBindingSchema, isNativeCliWorkerProfile, NativeCliWorkerError, type NativeCliWorkerBinding } from '#capabilities/index.js';

const NO_IMAGE = `sha256:${'0'.repeat(64)}`;
/** @deprecated B1-17: kept one release for unverified Enterprise callers. A worker base resolves through `resolveHostSandboxTaskProfile` (no image). */
export const nativeCliWorkerTaskBase = (base: ExecutionProfileDefinition): ExecutionProfileDefinition => 'imageId' in base.parameters ? base : { ...base, parameters: { ...base.parameters, imageId: NO_IMAGE } };
/** @deprecated B1-17: kept one release for unverified Enterprise callers; a worker base is stored as written. */
export function nativeCliWorkerStoredBase(base: ExecutionProfileDefinition): ExecutionProfileDefinition {
  if (base.parameters['imageId'] !== NO_IMAGE) return base; const { imageId, ...parameters } = base.parameters; void imageId; return { ...base, parameters };
}
/** Base is immutable task data, never an execution alternative. R8b (owner D1b): it runs in the host sandbox, so its image is optional.
 * `maxTurns` is read once here from the sealed argv (the CLI's turn-limit flag), for the driver. */
export function resolveNativeCliWorkerProfile(input: ExecutionProfileDefinition) {
  const { base, binding } = nativeCliWorkerParameters(input), task = resolveHostSandboxTaskProfile(base), entry = nativeCliAgent(binding.protocolFamily);
  if (!entry || task.siwcWorker || task.nativeSubscription?.provider !== entry.id || task.nativeSubscription.schemaVersion !== 2
    || !task.nativeSubscription.promptDelivery || !task.nativeSubscription.model || task.nativeSubscription.model.auxiliaryModelIds.length
    || task.nativeSubscription.preflight?.discovery !== 'disabled') throw new NativeCliWorkerError('NATIVE_CLI_WORKER_PROFILE_INVALID');
  const flag = entry.command.capabilities.maxTurns?.flag, turns = flag ? task.argv.indexOf(flag) : -1;
  return Object.freeze({ base, binding, entry, ...task, ...(turns >= 0 ? { maxTurns: Number(task.argv[turns + 1]) } : {}) });
}
export function createNativeCliWorkerProfile(base: ExecutionProfileDefinition, binding: NativeCliWorkerBinding): ExecutionProfileDefinition {
  const profile = nativeCliWorkerProfile(base, binding); resolveNativeCliWorkerProfile(profile); return profile;
}
