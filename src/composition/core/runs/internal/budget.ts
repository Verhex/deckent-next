import { executionRegistrySchema, type RunProposal } from '#domain/index.js';
import { workSpendingBasis, configuredProviderSpendCheckpoint } from '#engine/index.js';
import { assertNativeWorkerBinding, compileNativeCodingWorkInput, isNativeCodingTemplate, providerSpendingConfiguredBudget } from '#adapters/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { inspectConfiguredProviderSpendAccount } from '#composition/core/provider-spend/index.js';
import { type ConfigLoadOptions } from '#platform/index.js';
export async function readConfiguredRunBudget(root: string, scopeId: string, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(root, options);
  const inspected = await inspectConfiguredProviderSpendAccount(root, { schemaVersion: 1, scopeId, current: true }, options);
  if (inspected.checkpoint) return { checkpoint: inspected.checkpoint };
  const budget = providerSpendingConfiguredBudget(config, scopeId);
  return { checkpoint: budget ? configuredProviderSpendCheckpoint(budget) : null, source: 'configured' as const };
}
export async function classifyConfiguredRunSpending(root: string, proposal: RunProposal, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(root, options);
  const registry = config.admission ? executionRegistrySchema.parse(config.admission.registry) : null;
  const profiles = proposal.graph.tasks.map(task => {
    const ref = registry?.kinds.find(row => row.kind === task.kind)?.profile;
    const profile = registry?.profiles.find(row => row.id === ref?.id && row.version === ref.version) ?? null;
    const selected = profile && isNativeCodingTemplate(profile) && task.workInput ? compileNativeCodingWorkInput(profile, task.workInput) : profile;
    if (selected) assertNativeWorkerBinding(selected);
    return selected;
  });
  return workSpendingBasis(profiles);
}
