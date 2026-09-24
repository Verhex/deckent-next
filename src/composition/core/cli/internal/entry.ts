#!/usr/bin/env node
import { inspectConfiguredWorkers } from '#composition/core/worker-observation/index.js';
import { inspectConfiguredToolchainCurrency, updateConfiguredToolchains } from '#composition/core/toolchains/index.js';
import { inspectConfiguredWorkerTranscript } from '#composition/core/worker-observation/index.js';
import { executeConfiguredOperation, compensateConfiguredOperation, inspectConfiguredOperation } from '#composition/core/operations/index.js';
import { readConfiguredInferenceMetrics } from '#composition/core/inference-metrics/index.js';
import { adoptConfiguredWorkspaceIntegration, rollbackConfiguredWorkspaceIntegration, deliverConfiguredWorkspaceIntegration, inspectConfiguredWorkspaceIntegration, checkConfiguredWorkspaceIntegration, prepareConfiguredWorkspaceIntegration, prepareConfiguredWorkspacePatch, previewConfiguredWorkspacePatch } from '#composition/core/workspace-patch/index.js';
import { admitConfiguredModelActivation, inspectConfiguredModelActivation } from '#composition/core/model-activation/index.js';
import { createConfiguredRuntimeClient, invokeRuntimeModel, invokeRuntimeModelStream, inspectRuntimeModelInvocation, purgeRuntimeModelInvocationContent, cancelRuntimeModelInvocation, inspectRuntimeProviderSpendAccount, auditRuntimeProviderSpendAccount } from '#composition/core/runtime-service/index.js';
import { startConfiguredCliRuntimeService } from './runtime-host.js';
import { ensureConfiguredRuntimeService, openConfiguredTerminalHistory, restartConfiguredRuntimeService, stopConfiguredRuntimeService } from './runtime-autostart.js';
import { main as runCli } from '#surfaces/index.js';
import { previewSuppliedInstallation, inspectSuppliedInstallation, applySuppliedInstallation, resumeInstallation } from '#composition/core/installation/index.js';
import { getConfigFieldDefault, isMainModule } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { readInstallationProfileFile } from '#adapters/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { inspectDeclaredModels, inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { prepareNativeCodingProfile } from '#composition/core/native-coding/index.js';
import { completeTerminalChatTurn, describeTerminalChat, streamTerminalChatTurn } from '#composition/core/terminal-chat/index.js';

/** Only the composition root chooses adapters for the shipped executable. */
export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const root = process.cwd(), runtime = createConfiguredRuntimeClient(root);
  const isRuntimeServe = argv[0] === 'runtime' && argv[1] === 'serve';
  const handlesSignals = isRuntimeServe || (argv[0] === 'workers' && argv[1] === 'watch');
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (handlesSignals) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  try { return await runCli(argv, { initialize: registerProviderConfig, root, signal: controller.signal, startRuntimeService: startConfiguredCliRuntimeService,
    deliverWorkspaceIntegration: deliverConfiguredWorkspaceIntegration,
    adoptWorkspaceIntegration: adoptConfiguredWorkspaceIntegration, rollbackWorkspaceIntegration: rollbackConfiguredWorkspaceIntegration,
    inspectWorkerTranscript: inspectConfiguredWorkerTranscript, executeOperation: executeConfiguredOperation, compensateOperation: compensateConfiguredOperation, inspectOperation: inspectConfiguredOperation,
    inspectWorkspaceIntegration: inspectConfiguredWorkspaceIntegration,
    checkWorkspaceIntegration: checkConfiguredWorkspaceIntegration, prepareWorkspaceIntegration: prepareConfiguredWorkspaceIntegration,
    prepareWorkspacePatch: prepareConfiguredWorkspacePatch, previewWorkspacePatch: previewConfiguredWorkspacePatch,
    inspectWorkers: inspectConfiguredWorkers, inspectToolchainCurrency: (projectRoot, options) => inspectConfiguredToolchainCurrency(projectRoot, options),
    ensureRuntimeService: (projectRoot, options) => ensureConfiguredRuntimeService(projectRoot, options),
    restartRuntimeService: (projectRoot, options) => restartConfiguredRuntimeService(projectRoot, options),
    openTerminalHistory: (projectRoot, options) => openConfiguredTerminalHistory(projectRoot, options),
    stopRuntimeService: (projectRoot, options) => stopConfiguredRuntimeService(projectRoot, options),
    readInferenceMetrics: (projectRoot, input, options) => readConfiguredInferenceMetrics(projectRoot, input, options),
    updateToolchains: (projectRoot, input, options) => updateConfiguredToolchains(projectRoot, input, options),
    inspectDeclaredModels, inspectModelBinding, prepareCodingProfile: prepareNativeCodingProfile,
    renewApproval: input => runtime.renewApproval(input), listApprovals: input => runtime.listApprovals(input), inspectApproval: input => runtime.inspectApproval(input), decideApproval: input => runtime.decideApproval(input),
    invokeModel: invokeRuntimeModel,
    describeTerminalChatPlan: describeTerminalChat,
    completeTerminalChat: (projectRoot, input, options, signal) => completeTerminalChatTurn({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { invoke: invokeRuntimeModel, cancel: cancelRuntimeModelInvocation }),
    streamTerminalChat: (projectRoot, input, options, signal) => streamTerminalChatTurn({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { invokeStream: invokeRuntimeModelStream, cancel: cancelRuntimeModelInvocation }),
    inspectModelInvocation: inspectRuntimeModelInvocation, purgeModelInvocationContent: purgeRuntimeModelInvocationContent,
    cancelModelInvocation: cancelRuntimeModelInvocation,
    inspectProviderSpendAccount: inspectRuntimeProviderSpendAccount,
    auditProviderSpendAccount: auditRuntimeProviderSpendAccount,
    admitModelActivation: admitConfiguredModelActivation, inspectModelActivation: inspectConfiguredModelActivation,
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
    describeRuntimeService: (_root, options) => createConfiguredRuntimeClient(_root, options).describeService(),
    shutdownRuntimeService: (_root, command, options) => createConfiguredRuntimeClient(_root, options).shutdownService(command),
    inspectInventory: (_root, input) => runtime.inspectInventory(input),
    inspectRun: (_root, input) => runtime.inspectRun(input),
    deliverRunCancellation: (_root, input) => runtime.deliverRunCancellation(input),
    reserveRunTasks: (_root, input) => runtime.reserveRunTasks(input),
    createRun: (_root, input) => runtime.createRun(input),
    executeTask: (_root, input) => runtime.executeTask(input),
    evaluateTask: (_root, input) => runtime.evaluateTask(input),
  }); } finally { if (handlesSignals) { process.off('SIGINT', stop); process.off('SIGTERM', stop); } }
}
if (isMainModule(import.meta)) {
  void main().then(code => { if (process.argv[2] === 'runtime' && process.argv[3] === 'serve' && code !== 0) process.exit(code); else process.exitCode = code; });
}
