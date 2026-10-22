import { executionProfileDefinitionSchema, workerEffortSchema, type CatalogPinModelEvidence, type ExecutionProfileDefinition, type WorkerEffort } from '#domain/index.js';
import { resolveDockerTaskProfile } from '#adapters/core/docker-supervisor/index.js';
import { nativeCliCommand, nativeEffortArgs } from '#adapters/core/native-cli-registry/index.js';
import { assertNativeWorkerBinding, NativeWorkerBindingError } from './binding.js';
import { promptHash } from './composition.js';
/** Apply the same admitted selection to an operator-prepared pinned profile. Never alters prompt, model, work bounds or executable. Given catalog
 * `evidence` (owner K1/K2 2026-10-22), the pin's session-start names / provider-choice flag are replaced by exactly that data. */
export function bindNativeWorkerEffort(profile: ExecutionProfileDefinition, input: WorkerEffort, evidence?: CatalogPinModelEvidence): ExecutionProfileDefinition {
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
    // Only a pin that has or gains catalog evidence is rewritten, so other pins keep their exact bytes.
    ...(evidence && [evidence, binding.model].some(value => 'reportedNames' in value || 'otherReportedNames' in value || 'providerChosen' in value) ? { model: { channelId: binding.model.channelId, modelId: binding.model.modelId, auxiliaryModelIds: binding.model.auxiliaryModelIds, ...evidence } } : {}),
    ...(binding.preflight ? { preflight: { ...binding.preflight,
      requiredFlags: [...binding.preflight.requiredFlags.filter(flag => !oldFlags.includes(flag)), ...(selected.level === null ? [] : capability!.requiredFlags)] } } : {}),
    ...(binding.promptDelivery ? { promptDelivery: { ...binding.promptDelivery, argvSha256: promptHash(JSON.stringify(argv)) } } : {}),
  } } });
  assertNativeWorkerBinding(result); resolveDockerTaskProfile(result);
  return result;
}
