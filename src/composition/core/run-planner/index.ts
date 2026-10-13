import { executionRegistrySchema, type BrainPlanCommand,
  brainPlanCommandInputSchema, modelInvocationProfileSchema, type ModelInvocationCommand, type ModelInvocationCancellationCommand, type RunProposal } from '#domain/index.js';
import { BrainPlanApplication, prepareBrainRegistryPrompt, assertBrainContextFits, inspectAdmissibleWorkerModels, type ModelInvocationResult, modelInvocationRequestDigest, classifyWorkSpending } from '#engine/index.js';
import { ErrorRegistry, getConfigKnownSecrets, type ConfigLoadOptions } from '#platform/index.js';
import { extractOpenAiChatTextFromInvocation, isNativeCodingTemplate, nativeCodingTemplateWorker, openSqliteModelCatalogReader } from '#adapters/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { prepareTerminalChatCommand } from '#composition/core/terminal-chat/index.js';
import { invokeConfiguredModel, measureConfiguredModel } from '#composition/core/model-invocation/index.js';
import { inspectConfiguredRunProposal, proposeConfiguredRun, readConfiguredRunBudget } from '#composition/core/runs/index.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { isToolchainRefreshInProgress } from '#composition/core/toolchains/index.js';
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
        const selected = await prepareTerminalChatCommand({ projectRoot: root, scopeId: command.scopeId, messages: [], options }, false, command.reference);
        const configured = context.config['provider_invocation_profiles'] as { profiles: unknown[] } | undefined;
        const profile = configured?.profiles.map(value => modelInvocationProfileSchema.parse(value)).find(value => value.scopeId === command.scopeId
          && JSON.stringify(value.reference) === JSON.stringify(selected.command.reference)) ?? null;
        const spending = classifyWorkSpending({ kind: 'model', profile });
        const requiresTaskBudget = registry.profiles.every(value => !isNativeCodingTemplate(value) && classifyWorkSpending({ kind: 'worker', profile: value }) === 'metered');
        const needsBudget = spending === 'metered' || requiresTaskBudget;
        const snapshot = needsBudget ? await readConfiguredRunBudget(root, command.scopeId, options) : null;
        const account = snapshot?.checkpoint?.account, budget = account?.budget ?? null;
        if (needsBudget) {
          if (!budget) throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_MISSING');
          const remaining = budget.limitMinorUnits - (account?.reservedMinorUnits ?? 0) - (account?.settledMinorUnits ?? 0);
          if (account?.frozen || remaining <= 0) throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_EXCEEDED');
        }
        const templates = registry.profiles.filter(isNativeCodingTemplate).map(value => ({ profile: { id: value.id, version: value.version }, ...nativeCodingTemplateWorker(value) }));
        const catalog = await openSqliteModelCatalogReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs });
        let workerModels;
        try { workerModels = await inspectAdmissibleWorkerModels(templates, command.scopeId, catalog, Date.now(),
          { imageRefreshInProgress: await isToolchainRefreshInProgress(root, options) }); } finally { catalog.close(); }
        const kinds = registry.kinds.map(row => { const template = templates.find(value => value.profile.id === row.profile.id && value.profile.version === row.profile.version);
          return { kind: row.kind, profile: row.profile, type: template ? 'template' as const : 'prepared' as const, ...(template ? { provider: template.provider } : {}) }; });
        const prompt = prepareBrainRegistryPrompt(command, registry, budget ? { currency: budget.currency, limitMinorUnits: budget.limitMinorUnits } : null,
          context.config['brain_planner'], getConfigKnownSecrets(context.config), { kinds, workerModels });
        const prepared = await prepareTerminalChatCommand({ projectRoot: root, scopeId: command.scopeId, messages: prompt.messages, options }, false, selected.command.reference);
        assertBrainContextFits(prepared.command, context.config['brain_planner'], null, null); // complete byte guard before even the counter's HTTP effect
        const measured = await measureConfiguredModel(root, prepared.command, options, signal);
        if (signal?.aborted) throw ErrorRegistry.createError('BRAIN_CANCELLED');
        assertBrainContextFits(prepared.command, context.config['brain_planner'], profile?.contextWindowTokens ?? null, measured);
        return { invocation: prepared.command, prompt, kinds: registry.kinds.map(row => row.kind) };
      },
    }).plan(input, undefined, signal);
  } catch (error) { throw queryFailure(error); }
}
