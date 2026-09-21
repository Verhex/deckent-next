#!/usr/bin/env node
import { admitConfiguredModelActivation, inspectConfiguredModelActivation } from '#composition/core/model-activation/index.js';
import { createConfiguredRuntimeClient, invokeRuntimeModel, inspectRuntimeModelInvocation, purgeRuntimeModelInvocationContent, cancelRuntimeModelInvocation, inspectRuntimeProviderSpendAccount, auditRuntimeProviderSpendAccount } from '#composition/core/runtime-service/index.js';
import { startConfiguredCliRuntimeService } from './runtime-host.js';
import { main as runCli } from '#surfaces/index.js';
import { previewSuppliedInstallation, inspectSuppliedInstallation, applySuppliedInstallation, resumeInstallation } from '#composition/core/installation/index.js';
import { getConfigFieldDefault, isMainModule } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { readInstallationProfileFile } from '#adapters/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { inspectDeclaredModels, inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { prepareNativeCodingProfile } from '#composition/core/native-coding/index.js';

/** Only the composition root chooses adapters for the shipped executable. */
export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const root = process.cwd(), runtime = createConfiguredRuntimeClient(root);
  const isRuntimeServe = argv[0] === 'runtime' && argv[1] === 'serve';
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (isRuntimeServe) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  try { return await runCli(argv, { initialize: registerProviderConfig, root, signal: controller.signal, startRuntimeService: startConfiguredCliRuntimeService,
    inspectDeclaredModels, inspectModelBinding, prepareCodingProfile: prepareNativeCodingProfile,
    invokeModel: invokeRuntimeModel, inspectModelInvocation: inspectRuntimeModelInvocation, purgeModelInvocationContent: purgeRuntimeModelInvocationContent,
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
  }); } finally { if (isRuntimeServe) { process.off('SIGINT', stop); process.off('SIGTERM', stop); } }
}
if (isMainModule(import.meta)) {
  void main().then(code => { if (process.argv[2] === 'runtime' && process.argv[3] === 'serve' && code !== 0) process.exit(code); else process.exitCode = code; });
}
