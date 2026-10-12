import { executionRegistrySchema, type BrainPlanCommand,
  brainPlanCommandInputSchema, type ModelInvocationCommand, type ModelInvocationCancellationCommand, type RunProposal } from '#domain/index.js';
import { BrainPlanApplication, prepareBrainRegistryPrompt, type ModelInvocationResult, modelInvocationRequestDigest } from '#engine/index.js';
import { ErrorRegistry, getConfigKnownSecrets, type ConfigLoadOptions } from '#platform/index.js';
import { extractOpenAiChatTextFromInvocation, providerSpendingConfiguredBudget } from '#adapters/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { prepareTerminalChatCommand } from '#composition/core/terminal-chat/index.js';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { inspectConfiguredProviderSpendAccount } from '#composition/core/provider-spend/index.js';
import { inspectConfiguredRunProposal, proposeConfiguredRun } from '#composition/core/runs/index.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
/** SDK application contract. CLI/MCP/Terminal use the same application with the existing runtime invocation transport. */
export function planConfiguredRun(root: string, input: BrainPlanCommand, options: ConfigLoadOptions = {}, signal?: AbortSignal) {
  return plan(root, input, options, (command, signal) => invokeConfiguredModel(root, command, options, signal), signal);
}
export function planRuntimeRun(root: string, input: BrainPlanCommand, options: ConfigLoadOptions = {}, signal?: AbortSignal) {
  const client = createConfiguredRuntimeClient(root, options);
  return plan(root, input, options, async (command, signal) => {
    const cancel = () => { void client.cancelModelInvocation({ schemaVersion: 1, commandId: command.commandId + '-cancel', scopeId: command.scopeId,
      targetCommandId: command.commandId, reference: command.reference, expectedRequestDigest: modelInvocationRequestDigest(command) } satisfies ModelInvocationCancellationCommand).catch(() => undefined); };
    signal?.addEventListener('abort', cancel, { once: true });
    try { if (signal?.aborted) throw ErrorRegistry.createError('BRAIN_CANCELLED'); return await client.invokeModel(command, undefined, signal); }
    finally { signal?.removeEventListener('abort', cancel); }
  }, signal, proposal => client.proposeRun(proposal));
}
async function plan(root: string, input: BrainPlanCommand, options: ConfigLoadOptions,
  invoke: (command: ModelInvocationCommand, signal?: AbortSignal) => Promise<ModelInvocationResult>, signal?: AbortSignal,
  propose?: (proposal: RunProposal) => ReturnType<typeof proposeConfiguredRun>) {
  try {
    const parsed = brainPlanCommandInputSchema.safeParse(input);
    if (!parsed.success) throw ErrorRegistry.createError('BRAIN_INPUT_INVALID');
    input = parsed.data;
    await loadComposedConfig(root, options);
    const context = await loadConfiguredScopeContext(root, input.scopeId, options, 'write');
    return await new BrainPlanApplication({ verify: async () => context.principal }, {
      knownSecrets: getConfigKnownSecrets(context.config),
      inspect: query => inspectConfiguredRunProposal(root, query, options), invoke,
      propose: propose ?? (proposal => proposeConfiguredRun(root, proposal, options)), text: extractOpenAiChatTextFromInvocation,
      async prepare(command) {
        const registry = context.config.admission ? executionRegistrySchema.parse(context.config.admission.registry) : null;
        if (!registry) throw ErrorRegistry.createError('RUN_ADMISSION_NOT_CONFIGURED');
        const inspected = await inspectConfiguredProviderSpendAccount(root, { schemaVersion: 1, scopeId: command.scopeId, current: true }, options);
        const budget = inspected.checkpoint?.account.budget ?? providerSpendingConfiguredBudget(context.config, command.scopeId);
        if (!budget) throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_MISSING');
        const account = inspected.checkpoint?.account;
        const remaining = budget.limitMinorUnits - (account?.reservedMinorUnits ?? 0) - (account?.settledMinorUnits ?? 0);
        if (account?.frozen || remaining <= 0) throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_EXCEEDED');
        const prompt = prepareBrainRegistryPrompt(command, registry, { currency: budget.currency, limitMinorUnits: budget.limitMinorUnits },
          context.config['brain_planner'], getConfigKnownSecrets(context.config));
        const prepared = await prepareTerminalChatCommand({ projectRoot: root, scopeId: command.scopeId, messages: prompt.messages, options }, false, command.reference);
        return { invocation: prepared.command, prompt };
      },
    }).plan(input, undefined, signal);
  } catch (error) { throw queryFailure(error); }
}
