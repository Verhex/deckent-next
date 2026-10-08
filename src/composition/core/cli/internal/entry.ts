#!/usr/bin/env node
import { previewConfiguredIdentityProfile, listIdentityProfiles } from '#composition/core/identity-profile/index.js';
import { ensureConfiguredTerminalIdentity, inspectConfiguredInstallationBinding, resolveConfiguredInstallationIdentity, loadConfiguredInstallationIdentity, loadConfiguredProjectIdentity } from '#composition/core/scoped-request/index.js';
import { unifiedDiff, readInstallationProfileFile, isSelfSourceProject, PROVIDER_CONNECT_KINDS, probeProviderConnection, providerEndpoint } from '#adapters/index.js';
import { composeCore } from '#composition/core/root/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { inspectConfiguredWorkerTranscript, inspectConfiguredWorkers } from '#composition/core/worker-observation/index.js';
import { prepareConfiguredDecision, askConfiguredDecision, recordConfiguredDecision, outcomeConfiguredDecision, inspectConfiguredDecision } from '#composition/core/decision/index.js';
import { inspectMonitor, inspectSurfaceAccess, inspectSurfaceRunIds, followLedgerSurface } from '#composition/core/monitor/index.js';
import { inspectConfiguredToolchainCurrency, updateConfiguredToolchains, inspectToolchainRefresh } from '#composition/core/toolchains/index.js';
import { executeConfiguredOperation, compensateConfiguredOperation, inspectConfiguredOperation } from '#composition/core/operations/index.js';
import { configuredPolicyTemplateUpgrade, listConfiguredStandingGrants, revokeConfiguredStandingGrant } from '#composition/core/approvals/index.js';
import { readConfiguredInferenceMetrics } from '#composition/core/inference-metrics/index.js';
import { adoptConfiguredWorkspaceIntegration, rollbackConfiguredWorkspaceIntegration, deliverConfiguredWorkspaceIntegration, inspectConfiguredWorkspaceIntegration, checkConfiguredWorkspaceIntegration, prepareConfiguredWorkspaceIntegration, prepareConfiguredWorkspacePatch, previewConfiguredWorkspacePatch } from '#composition/core/workspace-patch/index.js';
import { admitConfiguredModelActivation, applyConfiguredModelCatalog, inspectConfiguredModelActivation, inspectConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import { createConfiguredRuntimeClient, invokeRuntimeModel, runRuntimeChatTurn, cancelRuntimeChatTurn, findRuntimeWorkspaceFiles, attachRuntimeWorkspaceFile, inspectRuntimeModelInvocation, purgeRuntimeModelInvocationContent, cancelRuntimeModelInvocation, inspectRuntimeProviderSpendAccount, auditRuntimeProviderSpendAccount } from '#composition/core/runtime-service/index.js';
import { startConfiguredCliRuntimeService } from './runtime-host.js';
import { applyConfiguredPoolCapacity, inspectConfiguredPoolCapacity, applyConfiguredRunLifecycle, applyConfiguredPoolHold, createConfiguredDeliveryRun, inspectConfiguredPoolHold } from '#composition/core/runs/index.js';
import { ensureConfiguredRuntimeService, openConfiguredTerminalHistory, openConfiguredTerminalSessions, restartConfiguredRuntimeService, stopConfiguredRuntimeService } from './runtime-autostart.js';
import { main as runCli } from '#surfaces/index.js';
import { previewSuppliedInstallation, inspectSuppliedInstallation, applySuppliedInstallation, resumeInstallation,
  applyPolicyTemplateInstallationWithSecretDefault, inspectPolicyTemplate, previewPolicyTemplateInstallation, upgradePolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { inspectConfiguredShellRealm, runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { getConfigFieldDefault, isMainModule } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { inspectDeclaredModels, inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { prepareNativeCodingProfile } from '#composition/core/native-coding/index.js';
import { assertTerminalChatReady, attachTerminalMentions, completeTerminalChatTurn, describeTerminalChat, findTerminalMentions, streamTerminalAgentTurn } from '#composition/core/terminal-chat/index.js';
import { assessConfiguredModelInvocationDelivery } from '#composition/core/model-invocation/index.js';
import { inspectConfiguredSecretStore, listConfiguredSecretNames, listConfiguredSecretStores } from '#composition/core/secrets/index.js';
export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const root = process.cwd(), runtime = createConfiguredRuntimeClient(root);
  const isRuntimeServe = argv[0] === 'runtime' && argv[1] === 'serve';
  const handlesSignals = isRuntimeServe || (argv[0] === 'workers' && argv[1] === 'watch') || (argv[0] === 'decide' && argv[1] === 'ask');
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (handlesSignals) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  try { return await runCli(argv, { initialize: composeCore, root, signal: controller.signal, startRuntimeService: startConfiguredCliRuntimeService,
    previewIdentityProfile: previewConfiguredIdentityProfile, listIdentityProfiles,
    prepareDecision: prepareConfiguredDecision, askDecision: askConfiguredDecision, recordDecision: recordConfiguredDecision, outcomeDecision: outcomeConfiguredDecision, inspectDecision: inspectConfiguredDecision,
    deliverWorkspaceIntegration: deliverConfiguredWorkspaceIntegration,
    adoptWorkspaceIntegration: adoptConfiguredWorkspaceIntegration, rollbackWorkspaceIntegration: rollbackConfiguredWorkspaceIntegration,
    inspectWorkerTranscript: inspectConfiguredWorkerTranscript, executeOperation: executeConfiguredOperation, compensateOperation: compensateConfiguredOperation, inspectOperation: inspectConfiguredOperation,
    inspectWorkspaceIntegration: inspectConfiguredWorkspaceIntegration,
    checkWorkspaceIntegration: checkConfiguredWorkspaceIntegration, prepareWorkspaceIntegration: prepareConfiguredWorkspaceIntegration,
    prepareWorkspacePatch: prepareConfiguredWorkspacePatch, previewWorkspacePatch: previewConfiguredWorkspacePatch, renderUnifiedDiff: unifiedDiff,
    configApplication: createConfiguredConfigApplication, resolveConfigPrincipal: resolveConfiguredConfigPrincipal,
    inspectToolchainRefresh,
    inspectWorkers: inspectConfiguredWorkers, inspectMonitor, inspectToolchainCurrency: (projectRoot, options) => inspectConfiguredToolchainCurrency(projectRoot, options), inspectSurfaceAccess, inspectSurfaceRunIds, followSurfaceEvents: followLedgerSurface,
    ensureRuntimeService: (projectRoot, options) => ensureConfiguredRuntimeService(projectRoot, options),
    restartRuntimeService: (projectRoot, options) => restartConfiguredRuntimeService(projectRoot, options),
    openTerminalHistory: (projectRoot, options) => openConfiguredTerminalHistory(projectRoot, options),
    openTerminalSessions: (projectRoot, options) => openConfiguredTerminalSessions(projectRoot, options),
    selfSourceProject: isSelfSourceProject,
    ensureTerminalIdentity: (projectRoot, scopeId, options) => ensureConfiguredTerminalIdentity(projectRoot, scopeId, options).catch(error => { throw queryFailure(error); }),
    resolveInstallationIdentity: resolveConfiguredInstallationIdentity, loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity,
    stopRuntimeService: (projectRoot, options) => stopConfiguredRuntimeService(projectRoot, options),
    readInferenceMetrics: (projectRoot, input, options) => readConfiguredInferenceMetrics(projectRoot, input, options),
    updateToolchains: (projectRoot, input, options) => updateConfiguredToolchains(projectRoot, input, options),
    runMcpCommand: runConfiguredMcpCommand,
    inspectSecretStore: inspectConfiguredSecretStore, listSecretNames: listConfiguredSecretNames,
    inspectInstallationBinding: inspectConfiguredInstallationBinding,
    inspectShellRealm: inspectConfiguredShellRealm, // REALM-NOTICE: doctor's selected shell realm and every provider passed over.
    setSecret: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).setSecret(input),
    // T4 PROVIDER-CONNECT: the /provider kinds (adapter data) and the free check, run in this terminal process with the key the person typed;
    // the key then goes only to `setSecret` above (runtime service, audited by name). No environment variable, file or worker sees it.
    providerConnect: { kinds: PROVIDER_CONNECT_KINDS.map(kind => ({ id: kind.id, labelKey: kind.labelKey, available: kind.available, endpointDefault: kind.endpoint.default,
      endpointEditable: kind.endpoint.editable, keyRequired: kind.key?.required ?? false, secretName: kind.key?.secretName ?? null, probePath: kind.probe?.path ?? null,
      endpointChoices: kind.endpoint.choices })),
    endpoint: providerEndpoint, probe: (input, signal) => probeProviderConnection(input, signal ? { signal } : {}) },
    deleteSecret: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).deleteSecret(input),
    listSecretStores: listConfiguredSecretStores,
    switchSecretStore: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).switchSecretStore(input),
    inspectDeclaredModels, inspectModelBinding, prepareCodingProfile: prepareNativeCodingProfile,
    clearSessionStanding: input => runtime.clearSessionStanding(input), renewApproval: input => runtime.renewApproval(input), listApprovals: input => runtime.listApprovals(input), inspectApproval: input => runtime.inspectApproval(input), decideApproval: input => runtime.decideApproval(input),
    invokeModel: invokeRuntimeModel,
    describeTerminalChatPlan: describeTerminalChat,
    completeTerminalChat: (projectRoot, input, options, signal) => completeTerminalChatTurn({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { invoke: invokeRuntimeModel, cancel: cancelRuntimeModelInvocation }),
    streamTerminalChat: (projectRoot, input, options, signal) => streamTerminalAgentTurn({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { chatTurn: runRuntimeChatTurn, cancelChatTurn: cancelRuntimeChatTurn, preflight: assertTerminalChatReady }),
    findTerminalMentions: (projectRoot, input, options, signal) => findTerminalMentions({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { find: findRuntimeWorkspaceFiles, attach: attachRuntimeWorkspaceFile }),
    attachTerminalMentions: (projectRoot, input, options, signal) => attachTerminalMentions({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { find: findRuntimeWorkspaceFiles, attach: attachRuntimeWorkspaceFile }),
    inspectPermissionMode: (projectRoot, input, options, signal) => createConfiguredRuntimeClient(projectRoot, options).inspectPermissionMode(input, signal),
    setPermissionMode: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).setPermissionMode(input),
    inspectScratch: (projectRoot, input, options, signal) => createConfiguredRuntimeClient(projectRoot, options).inspectScratch(input, signal),
    clearScratch: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).clearScratch(input),
    inspectModelInvocation: inspectRuntimeModelInvocation, purgeModelInvocationContent: purgeRuntimeModelInvocationContent,
    cancelModelInvocation: cancelRuntimeModelInvocation, inspectProviderSpendAccount: inspectRuntimeProviderSpendAccount, auditProviderSpendAccount: auditRuntimeProviderSpendAccount,
    admitModelActivation: admitConfiguredModelActivation, inspectModelActivation: inspectConfiguredModelActivation, applyModelCatalog: applyConfiguredModelCatalog, inspectModelCatalog: inspectConfiguredModelCatalog,
    applyPoolCapacity: applyConfiguredPoolCapacity, inspectPoolCapacity: inspectConfiguredPoolCapacity, applyRunLifecycle: applyConfiguredRunLifecycle, applyPoolHold: applyConfiguredPoolHold, inspectPoolHold: inspectConfiguredPoolHold, // K5 typed pool hold (local, ledger-read by the service)
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
    inspectPolicyTemplate: projectRoot => inspectPolicyTemplate(projectRoot),
    assessModelInvocationDelivery: (projectRoot, options) => assessConfiguredModelInvocationDelivery(projectRoot, options),
    listStandingGrants: listConfiguredStandingGrants, revokeStandingGrant: revokeConfiguredStandingGrant,
    upgradePolicyTemplate: (root, scopeId, input, options) => configuredPolicyTemplateUpgrade(root, scopeId, options, input).catch(error => { throw queryFailure(error); }),
    describeRuntimeService: (_root, options) => createConfiguredRuntimeClient(_root, options).describeService(),
    shutdownRuntimeService: (_root, command, options) => createConfiguredRuntimeClient(_root, options).shutdownService(command),
    inspectInventory: (_root, input) => runtime.inspectInventory(input), inspectRun: (_root, input) => runtime.inspectRun(input),
    deliverRunCancellation: (_root, input) => runtime.deliverRunCancellation(input),
    reserveRunTasks: (_root, input) => runtime.reserveRunTasks(input),
    createRun: (_root, input) => runtime.createRun(input), createDeliveryRun: createConfiguredDeliveryRun,
    executeTask: (_root, input) => runtime.executeTask(input), evaluateTask: (_root, input) => runtime.evaluateTask(input),
  }); } finally { if (handlesSignals) { process.off('SIGINT', stop); process.off('SIGTERM', stop); } }
}
if (isMainModule(import.meta)) {
  void main().then(code => { if (process.argv[2] === 'runtime' && process.argv[3] === 'serve' && code !== 0) process.exit(code); else process.exitCode = code; });
}
