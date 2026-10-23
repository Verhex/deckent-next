import { executionRegistrySchema, type RunProposal } from '#domain/index.js';
import { workSpendingBasis, configuredProviderSpendCheckpoint, assignTaskWorker, composeModelRolePolicy, type ModelCatalogReader } from '#engine/index.js';
import { assertNativeWorkerBinding, compileNativeCodingWorkInput, isNativeCodingTemplate, nativeCodingRefusalCode, providerSpendingConfiguredBudget } from '#adapters/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { inspectConfiguredProviderSpendAccount } from '#composition/core/provider-spend/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { isToolchainRefreshInProgress } from '#composition/core/toolchains/index.js';
import { readWorkerInstructions } from './worker-instructions.js';
export async function readConfiguredRunBudget(root: string, scopeId: string, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(root, options);
  const inspected = await inspectConfiguredProviderSpendAccount(root, { schemaVersion: 1, scopeId, current: true }, options);
  if (inspected.checkpoint) return { checkpoint: inspected.checkpoint };
  const budget = providerSpendingConfiguredBudget(config, scopeId);
  return { checkpoint: budget ? configuredProviderSpendCheckpoint(budget) : null, source: 'configured' as const };
}
/** `catalog`: the scope's model catalog reader. A task whose work input leaves the model open (ATAMA-1) is classified on the worker the system
 * would assign now (the same assignment as Run admission); without a reader such a task is the typed unassigned-model refusal. */
export async function classifyConfiguredRunSpending(root: string, proposal: RunProposal, options: ConfigLoadOptions,
  catalog?: () => Promise<ModelCatalogReader & { close(): void }>) {
  const config = await loadComposedConfig(root, options);
  const registry = config.admission ? executionRegistrySchema.parse(config.admission.registry) : null, instructions = await readWorkerInstructions(root, config, options);
  let reader: (ModelCatalogReader & { close(): void }) | null = null;
  try {
    const profiles = [];
    for (const task of proposal.graph.tasks) {
      const ref = registry?.kinds.find(row => row.kind === task.kind)?.profile;
      const profile = registry?.profiles.find(row => row.id === ref?.id && row.version === ref.version) ?? null;
      // A work input the worker cannot run (e.g. maxTurns on a CLI without a turn limit) is a typed refusal here as at creation (create.ts),
      // never an unexpected failure (live /do 2026-10-16: QUERY_UNEXPECTED_FAILURE from NATIVE_CODING_TURN_LIMIT_UNSUPPORTED).
      let selected = profile;
      if (profile && isNativeCodingTemplate(profile) && task.workInput) {
        if (instructions.oversize) throw ErrorRegistry.createError('WORKER_INSTRUCTIONS_TOO_LARGE'); // the same snapshot refusal as at creation
        const compile = (template: typeof profile, input: typeof task.workInput, evidence?: Parameters<typeof compileNativeCodingWorkInput>[3]) => {
          try { return compileNativeCodingWorkInput(template, input, undefined, evidence, instructions.parts); } catch (error) { throw ErrorRegistry.createError(nativeCodingRefusalCode(error)); }
        };
        let input = task.workInput;
        if (!input.model && catalog) {
          reader ??= await catalog();
          input = (await assignTaskWorker(task, input, profile, registry?.workClasses, reader, compile,
            { scopeId: proposal.scopeId, nowMs: Date.now(), imageRefreshInProgress: await isToolchainRefreshInProgress(root, options),
              roles: composeModelRolePolicy(config['model_roles']) })).input;
        }
        selected = compile(profile, input);
      }
      if (selected) assertNativeWorkerBinding(selected);
      profiles.push(selected);
    }
    return workSpendingBasis(profiles);
  } finally { reader?.close(); }
}
