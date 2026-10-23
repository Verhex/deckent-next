import { executionRegistrySchema, type RunProposal } from '#domain/index.js';
import { workSpendingBasis, configuredProviderSpendCheckpoint } from '#engine/index.js';
import { assertNativeWorkerBinding, compileNativeCodingWorkInput, isNativeCodingTemplate, nativeCodingRefusalCode, providerSpendingConfiguredBudget } from '#adapters/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { inspectConfiguredProviderSpendAccount } from '#composition/core/provider-spend/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { readWorkerInstructions } from './worker-instructions.js';
export async function readConfiguredRunBudget(root: string, scopeId: string, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(root, options);
  const inspected = await inspectConfiguredProviderSpendAccount(root, { schemaVersion: 1, scopeId, current: true }, options);
  if (inspected.checkpoint) return { checkpoint: inspected.checkpoint };
  const budget = providerSpendingConfiguredBudget(config, scopeId);
  return { checkpoint: budget ? configuredProviderSpendCheckpoint(budget) : null, source: 'configured' as const };
}
export async function classifyConfiguredRunSpending(root: string, proposal: RunProposal, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(root, options);
  const registry = config.admission ? executionRegistrySchema.parse(config.admission.registry) : null, instructions = await readWorkerInstructions(root, config, options);
  const profiles = proposal.graph.tasks.map(task => {
    const ref = registry?.kinds.find(row => row.kind === task.kind)?.profile;
    const profile = registry?.profiles.find(row => row.id === ref?.id && row.version === ref.version) ?? null;
    // A work input the worker cannot run (e.g. maxTurns on a CLI without a turn limit) is a typed refusal here as at creation (create.ts),
    // never an unexpected failure (live /do 2026-10-16: QUERY_UNEXPECTED_FAILURE from NATIVE_CODING_TURN_LIMIT_UNSUPPORTED).
    let selected = profile;
    if (profile && isNativeCodingTemplate(profile) && task.workInput) {
      if (instructions.oversize) throw ErrorRegistry.createError('WORKER_INSTRUCTIONS_TOO_LARGE'); // the same snapshot refusal as at creation
      try { selected = compileNativeCodingWorkInput(profile, task.workInput, undefined, undefined, instructions.parts); } catch (error) { throw ErrorRegistry.createError(nativeCodingRefusalCode(error)); }
    }
    if (selected) assertNativeWorkerBinding(selected);
    return selected;
  });
  return workSpendingBasis(profiles);
}
