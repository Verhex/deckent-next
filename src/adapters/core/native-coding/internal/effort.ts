import { executionProfileDefinitionSchema, workerEffortSchema, type ExecutionProfileDefinition, type WorkerEffort } from '#domain/index.js';
import { resolveDockerTaskProfile } from '#adapters/core/docker-supervisor/index.js';
import { nativeCliCommand, nativeEffortArgs } from '#adapters/core/native-cli-registry/index.js';
import { assertNativeWorkerBinding, NativeWorkerBindingError } from './binding.js';
import { promptHash } from './composition.js';
/** Apply the same admitted selection to an operator-prepared pinned profile. Never alters prompt, model, work bounds or executable. */
export function bindNativeWorkerEffort(profile: ExecutionProfileDefinition, input: WorkerEffort): ExecutionProfileDefinition {
  assertNativeWorkerBinding(profile);
  const selected = workerEffortSchema.parse(input), resolved = resolveDockerTaskProfile(profile), binding = resolved.nativeSubscription;
  if (!binding?.model) throw new NativeWorkerBindingError();
  const command = nativeCliCommand(binding.provider), capability = command.capabilities.reasoningEffort;
  let offset = 1 + command.args.length;
  if (command.capabilities.maxTurns && resolved.argv[offset] === command.capabilities.maxTurns.flag) offset += 2;
  const previous = binding.reasoningEffort ? nativeEffortArgs(capability, binding.reasoningEffort) : [];
  const next = nativeEffortArgs(capability, selected);
  const argv = [...resolved.argv.slice(0, offset), ...next, ...resolved.argv.slice(offset + previous.length)];
  const oldFlags = binding.reasoningEffort?.level != null ? capability?.requiredFlags ?? [] : [];
  const result = executionProfileDefinitionSchema.parse({ ...profile, parameters: { ...profile.parameters, argv, nativeSubscription: {
    ...binding, reasoningEffort: selected, effortMode: capability?.mode ?? null,
    ...(binding.preflight ? { preflight: { ...binding.preflight,
      requiredFlags: [...binding.preflight.requiredFlags.filter(flag => !oldFlags.includes(flag)), ...(selected.level === null ? [] : capability!.requiredFlags)] } } : {}),
    ...(binding.promptDelivery ? { promptDelivery: { ...binding.promptDelivery, argvSha256: promptHash(JSON.stringify(argv)) } } : {}),
  } } });
  assertNativeWorkerBinding(result); resolveDockerTaskProfile(result);
  return result;
}
