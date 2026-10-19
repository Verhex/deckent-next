#!/usr/bin/env node
import { planRuntimeRun } from '#composition/core/run-planner/index.js';
import { inspectInstallationStartability, createConfiguredRuntimeClient, configuredTargetQueueTerminal, invokeRuntimeModel, runRuntimeChatTurn, cancelRuntimeChatTurn, findRuntimeWorkspaceFiles, attachRuntimeWorkspaceFile, inspectRuntimeModelInvocation, purgeRuntimeModelInvocationContent, cancelRuntimeModelInvocation, inspectRuntimeProviderSpendAccount, auditRuntimeProviderSpendAccount, manageRuntimeProviderSpend } from '#composition/core/runtime-service/index.js';
import { configuredProjectInstructions } from '#composition/core/project-instructions/index.js';
import { executeConfiguredBackup, inspectConfiguredRecoveryFiles } from '#composition/core/backup/index.js';
import { previewConfiguredIdentityProfile, listIdentityProfiles, listConfiguredIdentityDistributionChoices, previewConfiguredIdentityDistribution, applyConfiguredIdentityDistribution } from '#composition/core/identity-profile/index.js';
import { ensureConfiguredTerminalIdentity, inspectConfiguredInstallationBinding, resolveConfiguredInstallationIdentity, loadConfiguredInstallationIdentity, loadConfiguredProjectIdentity } from '#composition/core/scoped-request/index.js';
import { unifiedDiff, readInstallationProfileFile, isSelfSourceProject, PROVIDER_CONNECT_KINDS, PROVIDER_CONNECT_LEGACY_KEYS, probeProviderConnection, providerEndpoint, providerConnectFamily, providerConnectKind, providerConnectModelPriced, providerConnectSecretName, readProviderConnectSeed } from '#adapters/index.js';
import { settledProviderCacheUsage } from '#engine/index.js';
import { composeCore } from '#composition/core/root/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal, configuredConfigChoiceSources } from '#composition/core/config/index.js';
import { inspectConfiguredWorkerTranscript, inspectConfiguredWorkers } from '#composition/core/worker-observation/index.js';
import { prepareConfiguredDecision, askConfiguredDecision, recordConfiguredDecision, outcomeConfiguredDecision, inspectConfiguredDecision } from '#composition/core/decision/index.js';
import { inspectMonitor, inspectSurfaceAccess, inspectSurfaceRunIds, followLedgerSurface } from '#composition/core/monitor/index.js';
import { inspectConfiguredToolchainCurrency, updateConfiguredToolchains, inspectToolchainRefresh } from '#composition/core/toolchains/index.js';
import { executeConfiguredOperation, compensateConfiguredOperation, inspectConfiguredOperation } from '#composition/core/operations/index.js';
import { changeConfiguredDecisionDelegation, inspectConfiguredDecisionDelegations, configuredPolicyTemplateUpgrade, inspectConfiguredPolicyAdministration, listConfiguredStandingGrants, revokeConfiguredStandingGrant, listConfiguredMcpCapabilityScopes, inspectConfiguredMcpCapabilities, changeConfiguredMcpCapabilities } from '#composition/core/approvals/index.js';
import { readConfiguredInferenceMetrics } from '#composition/core/inference-metrics/index.js';
import { interactiveDeliveryHandlers, inspectConfiguredWorkspaceIntegration, checkConfiguredWorkspaceIntegration, prepareConfiguredWorkspaceIntegration, prepareConfiguredWorkspacePatch, previewConfiguredWorkspacePatch } from '#composition/core/workspace-patch/index.js';
import { admitConfiguredModelActivation, applyConfiguredModelCatalog, inspectConfiguredModelActivation, inspectConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import { connectConfiguredModel, listConfiguredConnectionModels, planConfiguredProfileCache, planConfiguredProfileProtocol, inspectConfiguredModelReadiness, prepareConfiguredModelSwitch } from '#composition/core/model-connect/index.js';
import { startConfiguredCliRuntimeService } from './runtime-host.js';
import { releaseConfiguredQuota, applyConfiguredPoolCapacity, inspectConfiguredPoolCapacity, applyConfiguredRunLifecycle, applyConfiguredPoolHold, createConfiguredDeliveryRun, inspectConfiguredPoolHold } from '#composition/core/runs/index.js';
import { ensureConfiguredRuntimeService, openConfiguredTerminalHistory, openConfiguredTerminalSessions, restartConfiguredRuntimeService, stopConfiguredRuntimeService } from './runtime-autostart.js';
import { main as runCli, openConfigWindow, askDeliveryConfirmation, attachTerminalMentions, findTerminalMentions, streamTerminalAgentTurn, resolveCliLocale } from '#surfaces/index.js';
import { previewSuppliedInstallation, inspectSuppliedInstallation, applySuppliedInstallation, resumeInstallation, applyPolicyTemplateInstallationWithSecretDefault, inspectPolicyTemplate, previewPolicyTemplateInstallation, upgradePolicyTemplateInstallation, installConfiguredExecutionPool } from '#composition/core/installation/index.js';
import { inspectConfiguredShellRealm, runConfiguredMcpCommand, chatTurnRoundCommandId } from '#composition/core/agent-turn/index.js';
import { getConfigFieldDefault, isMainModule, envValue, loadConfigLanguage, loadConfigAgentEnvironment, loadConfig, type Locale } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { inspectDeclaredModels, inspectModelBinding, openConfiguredProviderWorkspaces } from '#composition/core/provider-catalog/index.js';
import { prepareNativeCodingProfile, configureNativeCodingTemplate, initializeNativeCodingRegistry } from '#composition/core/native-coding/index.js';
import { assertTerminalChatReady, completeTerminalChatTurn, describeTerminalChat } from '#composition/core/terminal-chat/index.js';
import { assessConfiguredModelInvocationDelivery, inspectConfiguredModelInvocationCommand, inspectConfiguredInvocableModels } from '#composition/core/model-invocation/index.js';
import { verifyConfiguredAudit, rebaselineConfiguredAudit } from '#composition/core/audit/index.js';
import { inspectConfiguredSecretStore, listConfiguredSecretNames, listConfiguredSecretStores } from '#composition/core/secrets/index.js';
/**
 * L-KIT: the call's locale, resolved once here and handed to every command (`context.locale`): `--lang`, DECKENT_LANGUAGE/DECKENT_LANG,
 * config `language`, LC_ALL, LC_MESSAGES, LANG. Presentation only: a config that cannot be read falls back to the environment, never blocks.
 */
export async function hostLocale(argv: readonly string[], root: string, env: NodeJS.ProcessEnv = process.env): Promise<Locale> {
  const at = argv.indexOf('--lang'), flag = at >= 0 && !argv[at + 1]?.startsWith('-') ? argv[at + 1] : undefined;
  // A supported flag or DECKENT_LANGUAGE/DECKENT_LANG outranks config: no config read is needed then (an unsupported value is passed over).
  const decisive = [flag, envValue(env, 'DECKENT_LANGUAGE'), envValue(env, 'DECKENT_LANG')]
    .some(value => !!value && resolveCliLocale({ flag: value, env: {} }) === value.slice(0, 2).toLowerCase());
  if (decisive) return resolveCliLocale({ flag, env });
  let configLanguage: string | undefined;
  try { configLanguage = await loadConfigLanguage(root, { env }); } catch { /* unreadable or invalid config: the environment chain decides */ }
  return resolveCliLocale({ flag, env, configLanguage });
}
/** The long-running commands whose SIGINT/SIGTERM cancel the call (besides `runtime serve`); a cli-grouped-help test pins each name to the catalog. */
export const SIGNAL_COMMANDS: readonly (readonly [string, string?])[] = Object.freeze([['do'], ['workers', 'watch'], ['decide', 'ask'],
  ['task', 'integration-deliver'], ['task', 'integration-adopt'], ['task', 'integration-rollback']]);
/** INIT-D7: the installation's `cli.agentEnvironment`, read like the language (presentation only); unreadable or invalid → the kit default. */
export const hostAgentEnvironment = (root: string, env: NodeJS.ProcessEnv = process.env) => loadConfigAgentEnvironment(root, { env }).catch(() => undefined);
export async function main(argv: readonly string[] = process.argv.slice(2), serviceEntry?: string) {
  const root = process.cwd(), runtime = createConfiguredRuntimeClient(root);
  const [locale, agentEnvironment] = await Promise.all([hostLocale(argv, root), hostAgentEnvironment(root)]);
  const isRuntimeServe = argv[0] === 'runtime' && argv[1] === 'serve', handlesSignals = isRuntimeServe || SIGNAL_COMMANDS.some(([family, action]) => argv[0] === family && (action === undefined || argv[1] === action));
  const controller = new AbortController();
  const delivery = interactiveDeliveryHandlers(async view => askDeliveryConfirmation(view, locale, process.stdin, process.stderr,
    { timeoutMs: (await loadConfig(root)).approvals.sessionTtlMs, signal: controller.signal }));
  const stop = () => controller.abort();
  if (handlesSignals) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  try { return await runCli(argv, { initialize: composeCore, root, locale, ...(agentEnvironment ? { agentEnvironment } : {}), signal: controller.signal, startRuntimeService: startConfiguredCliRuntimeService,
    verifyAudit: verifyConfiguredAudit, rebaselineAudit: rebaselineConfiguredAudit, executeBackup: executeConfiguredBackup, previewIdentityProfile: previewConfiguredIdentityProfile, listIdentityProfiles,
    listIdentityDistributionChoices: listConfiguredIdentityDistributionChoices, previewIdentityDistribution: previewConfiguredIdentityDistribution, applyIdentityDistribution: applyConfiguredIdentityDistribution,
    prepareDecision: prepareConfiguredDecision, askDecision: askConfiguredDecision, recordDecision: recordConfiguredDecision, outcomeDecision: outcomeConfiguredDecision, inspectDecision: inspectConfiguredDecision,
    ...configuredTargetQueueTerminal(root),
    deliverWorkspaceIntegration: delivery.deliver,
    adoptWorkspaceIntegration: delivery.adopt, rollbackWorkspaceIntegration: delivery.rollback, interactiveDelivery: interactiveDeliveryHandlers, // TESLIM-PENCERESI window answer
    inspectWorkerTranscript: inspectConfiguredWorkerTranscript, executeOperation: executeConfiguredOperation, compensateOperation: compensateConfiguredOperation, inspectOperation: inspectConfiguredOperation,
    inspectWorkspaceIntegration: inspectConfiguredWorkspaceIntegration,
    checkWorkspaceIntegration: checkConfiguredWorkspaceIntegration, prepareWorkspaceIntegration: prepareConfiguredWorkspaceIntegration,
    prepareWorkspacePatch: prepareConfiguredWorkspacePatch, previewWorkspacePatch: previewConfiguredWorkspacePatch, renderUnifiedDiff: unifiedDiff,
    configChoiceSources: configuredConfigChoiceSources, configApplication: createConfiguredConfigApplication, resolveConfigPrincipal: resolveConfiguredConfigPrincipal,
    openConfigPanel: openConfigWindow, // C-SETUP: `deckent config` on a terminal = the `/config` window (lazy view)
    inspectToolchainRefresh,
    inspectWorkers: inspectConfiguredWorkers, inspectMonitor, inspectToolchainCurrency: (projectRoot, options) => inspectConfiguredToolchainCurrency(projectRoot, options), inspectSurfaceAccess, inspectSurfaceRunIds, followSurfaceEvents: followLedgerSurface,
    ensureRuntimeService: (projectRoot, options) => ensureConfiguredRuntimeService(projectRoot, options, undefined, serviceEntry),
    restartRuntimeService: (projectRoot, options) => restartConfiguredRuntimeService(projectRoot, options, undefined, serviceEntry),
    openProjectInstructions: configuredProjectInstructions,
    openTerminalHistory: (projectRoot, options) => openConfiguredTerminalHistory(projectRoot, options),
    openTerminalSessions: (projectRoot, options) => openConfiguredTerminalSessions(projectRoot, options),
    selfSourceProject: isSelfSourceProject,
    ensureTerminalIdentity: (projectRoot, scopeId, options) => ensureConfiguredTerminalIdentity(projectRoot, scopeId, options).catch(error => { throw queryFailure(error); }),
    resolveInstallationIdentity: resolveConfiguredInstallationIdentity, loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity,
    stopRuntimeService: (projectRoot, options) => stopConfiguredRuntimeService(projectRoot, options),
    readInferenceMetrics: (projectRoot, input, options) => readConfiguredInferenceMetrics(projectRoot, input, options),
    updateToolchains: (projectRoot, input, options) => updateConfiguredToolchains(projectRoot, input, options),
    runMcpCommand: runConfiguredMcpCommand,
    inspectSecretStore: inspectConfiguredSecretStore, listSecretNames: listConfiguredSecretNames, inspectRecoveryFiles: inspectConfiguredRecoveryFiles,
    inspectInstallationBinding: inspectConfiguredInstallationBinding,
    inspectInstallationStartability, inspectShellRealm: inspectConfiguredShellRealm, // REALM-NOTICE: doctor's selected shell realm and every provider passed over.
    setSecret: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).setSecret(input),
    /* T4 PROVIDER-CONNECT: the /provider kinds (adapter data) and the free check, run in this terminal process with the key the person typed; the key then goes only to `setSecret` above (runtime service, audited by name). No environment variable, file or worker sees it. */ providerConnect: { kinds: PROVIDER_CONNECT_KINDS.map(kind => ({ id: kind.id, labelKey: kind.labelKey, available: kind.available, endpointDefault: kind.endpoint.default,
      endpointEditable: kind.endpoint.editable, keyRequired: kind.key?.required ?? false, secretName: kind.key?.secretName ?? null, probePath: kind.probe?.path ?? null,
      endpointChoices: kind.endpoint.choices, catalogProviderId: kind.connect?.seed ?? null, connectFamily: providerConnectFamily(kind), seeded: Boolean(kind.connect?.seed),
      priceRequired: kind.connect?.priceRequired ?? false })),
    endpoint: providerEndpoint, probe: (input, signal) => probeProviderConnection(input, signal ? { signal } : {}),
    legacyKeys: PROVIDER_CONNECT_LEGACY_KEYS,
    /* T4-B: the per-connection key name (the generic row derives it from the host) and a seeded kind's models (exact ids from its packaged seed). */ secretName: (id, endpoint) => { const kind = providerConnectKind(id); if (!kind) return null; const base = endpoint === null ? null : providerEndpoint(endpoint);
      return providerConnectSecretName(kind, base?.ok ? base.base : null); },
    discoverModels: listConfiguredConnectionModels,
    seedModels: async id => { const kind = providerConnectKind(id), seed = kind?.connect?.seed; if (!kind || !seed) return [];
      return (await readProviderConnectSeed(seed)).providers.flatMap(provider => provider.models.map(model => ({ nativeId: model.nativeId,
        displayName: (model as { displayName?: string }).displayName ?? model.nativeId, priced: providerConnectModelPriced(kind, model.nativeId) }))); } },
    deleteSecret: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).deleteSecret(input),
    listSecretStores: listConfiguredSecretStores,
    switchSecretStore: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).switchSecretStore(input),
    inspectDeclaredModels, inspectModelBinding, prepareCodingProfile: prepareNativeCodingProfile, configureCodingTemplate: configureNativeCodingTemplate, initializeNativeCodingRegistry,
    clearSessionStanding: input => runtime.clearSessionStanding(input), renewApproval: input => runtime.renewApproval(input), listApprovals: input => runtime.listApprovals(input), inspectApproval: input => runtime.inspectApproval(input), decideApproval: input => runtime.decideApproval(input),
    invokeModel: invokeRuntimeModel,
    planRun: planRuntimeRun,
    describeTerminalChatPlan: describeTerminalChat,
    completeTerminalChat: (projectRoot, input, options, signal) => completeTerminalChatTurn({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { invoke: invokeRuntimeModel, cancel: cancelRuntimeModelInvocation }),
    streamTerminalChat: (projectRoot, input, options, signal) => streamTerminalAgentTurn({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { chatTurn: runRuntimeChatTurn, cancelChatTurn: cancelRuntimeChatTurn, preflight: assertTerminalChatReady,
        settledUsage: async (root, command, round, options) => {
          const reference = command.reference ?? (await describeTerminalChat(root, options)).reference;
          return settledProviderCacheUsage((reference ? await inspectConfiguredModelInvocationCommand(root, { schemaVersion: 1, scopeId: command.scopeId,
            commandId: chatTurnRoundCommandId(command.scopeId, command.turnId, round), reference }, options) : null)?.spending ?? null);
        } }),
    findTerminalMentions: (projectRoot, input, options, signal) => findTerminalMentions({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { find: findRuntimeWorkspaceFiles, attach: attachRuntimeWorkspaceFile }),
    attachTerminalMentions: (projectRoot, input, options, signal) => attachTerminalMentions({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { find: findRuntimeWorkspaceFiles, attach: attachRuntimeWorkspaceFile }),
    inspectPermissionMode: (projectRoot, input, options, signal) => createConfiguredRuntimeClient(projectRoot, options).inspectPermissionMode(input, signal),
    setPermissionMode: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).setPermissionMode(input),
    inspectScratch: (projectRoot, input, options, signal) => createConfiguredRuntimeClient(projectRoot, options).inspectScratch(input, signal),
    clearScratch: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).clearScratch(input),
    inspectModelInvocation: inspectRuntimeModelInvocation, purgeModelInvocationContent: purgeRuntimeModelInvocationContent,
    cancelModelInvocation: cancelRuntimeModelInvocation, inspectProviderSpendAccount: inspectRuntimeProviderSpendAccount, auditProviderSpendAccount: auditRuntimeProviderSpendAccount, manageProviderSpend: manageRuntimeProviderSpend,
    admitModelActivation: admitConfiguredModelActivation, inspectModelActivation: inspectConfiguredModelActivation, applyModelCatalog: applyConfiguredModelCatalog, inspectModelCatalog: inspectConfiguredModelCatalog,
    /* T4-B models.connect: the secret store is read for names only (the key's presence), the service describe for the restart state. */ planProfileCache: planConfiguredProfileCache, // CACHE-SLICE1: the governed 5-minute cache migration offered in `/model` and `/provider`.
    inspectModelReadiness: inspectConfiguredModelReadiness, prepareModelSwitch: prepareConfiguredModelSwitch, inspectInvocableModels: inspectConfiguredInvocableModels,
    planProfileProtocol: planConfiguredProfileProtocol, openProviderWorkspaces: openConfiguredProviderWorkspaces,
    connectModel: (projectRoot, command, options) => connectConfiguredModel(projectRoot, command, options, { listSecretNames: listConfiguredSecretNames,
      describeService: (describeRoot, describeOptions) => createConfiguredRuntimeClient(describeRoot, describeOptions).describeService() }),
    releaseQuota: releaseConfiguredQuota, applyPoolCapacity: applyConfiguredPoolCapacity, inspectPoolCapacity: inspectConfiguredPoolCapacity, applyRunLifecycle: applyConfiguredRunLifecycle, applyPoolHold: applyConfiguredPoolHold, inspectPoolHold: inspectConfiguredPoolHold, // K5 typed pool hold (local, ledger-read by the service)
    previewInstallation: async (projectRoot, input) => {
      try { return await previewSuppliedInstallation(projectRoot,
        await readInstallationProfileFile(input.profilePath, getConfigFieldDefault('installation').profileMaxBytes),
        { allowShutdown: input.allowShutdown }); }
      catch (error) { throw queryFailure(error); }
    },
    inspectInstallation: async (projectRoot, input) => {
      try { return await inspectSuppliedInstallation(projectRoot,
        await readInstallationProfileFile(input.profilePath, getConfigFieldDefault('installation').profileMaxBytes),
        { allowShutdown: input.allowShutdown, dockerExecutable: input.dockerExecutable }); }
      catch (error) { throw queryFailure(error); }
    },
    applyInstallation: async (projectRoot, input) => {
      try { return await applySuppliedInstallation(projectRoot,
        await readInstallationProfileFile(input.profilePath, getConfigFieldDefault('installation').profileMaxBytes),
        { allowShutdown: input.allowShutdown, dockerExecutable: input.dockerExecutable,
          proposalDigest: input.proposalDigest, acceptCustom: input.acceptCustom }); }
      catch (error) { throw queryFailure(error); }
    },
    resumeInstallation: async (projectRoot, input) => {
      try { return await resumeInstallation(projectRoot, input); }
      catch (error) { throw queryFailure(error); }
    },
    previewPolicyTemplateInstallation: (projectRoot, scopeId) => previewPolicyTemplateInstallation(projectRoot, scopeId).catch(error => { throw queryFailure(error); }),
    applyPolicyTemplateInstallation: (projectRoot, scopeId) => applyPolicyTemplateInstallationWithSecretDefault(projectRoot, scopeId).catch(error => { throw queryFailure(error); }),
    upgradePolicyTemplateInstallation: (projectRoot, scopeId, apply, expect, person) => upgradePolicyTemplateInstallation(projectRoot, scopeId, apply, expect, {}, process.getuid?.(), person)
      .catch(error => { throw queryFailure(error); }),
    installConfiguredExecutionPool: (projectRoot, scopeId, apply) => installConfiguredExecutionPool(projectRoot, scopeId, apply).catch(error => { throw queryFailure(error); }),
    inspectPolicyTemplate: (projectRoot, options) => inspectPolicyTemplate(projectRoot, options),
    assessModelInvocationDelivery: (projectRoot, options) => assessConfiguredModelInvocationDelivery(projectRoot, options),
    listStandingGrants: listConfiguredStandingGrants, revokeStandingGrant: revokeConfiguredStandingGrant,
    inspectPolicyAdministration: inspectConfiguredPolicyAdministration,
    upgradePolicyTemplate: (root, scopeId, input, options) => configuredPolicyTemplateUpgrade(root, scopeId, options, input).catch(error => { throw queryFailure(error); }),
    delegations: { inspect: inspectConfiguredDecisionDelegations, change: changeConfiguredDecisionDelegation },
    mcpCapabilities: { listMcpCapabilityScopes: listConfiguredMcpCapabilityScopes, inspectMcpCapabilities: inspectConfiguredMcpCapabilities, changeMcpCapabilities: changeConfiguredMcpCapabilities },
    describeRuntimeService: (_root, options) => createConfiguredRuntimeClient(_root, options).describeService(),
    shutdownRuntimeService: (_root, command, options) => createConfiguredRuntimeClient(_root, options).shutdownService(command),
    inspectInventory: (_root, input) => runtime.inspectInventory(input), inspectRun: (_root, input) => runtime.inspectRun(input),
    deliverRunCancellation: (_root, input) => runtime.deliverRunCancellation(input),
    reserveRunTasks: (_root, input) => runtime.reserveRunTasks(input),
    proposeRun: (_root, input) => runtime.proposeRun(input), inspectRunProposal: (_root, input) => runtime.inspectRunProposal(input),
    createRun: (_root, input) => runtime.createRun(input), createDeliveryRun: createConfiguredDeliveryRun,
    executeTask: (_root, input) => runtime.executeTask(input), evaluateTask: (_root, input) => runtime.evaluateTask(input),
  }); } finally { if (handlesSignals) { process.off('SIGINT', stop); process.off('SIGTERM', stop); } }
}
if (isMainModule(import.meta)) {
  void main().then(code => { if (process.argv[2] === 'runtime' && process.argv[3] === 'serve' && code !== 0) process.exit(code); else process.exitCode = code; });
}
