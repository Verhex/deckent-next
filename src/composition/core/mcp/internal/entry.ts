#!/usr/bin/env node
import { loadComposedConfig } from '#composition/core/root/index.js';
import { admitConfiguredModelActivation, applyConfiguredModelCatalog, inspectConfiguredModelActivation, inspectConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfiguredInstallationIdentity } from '#composition/core/scoped-request/index.js';
import { resolveLocale, isMainModule } from '#platform/index.js';
import { createBoundedMcpTransport } from '#adapters/index.js';
import { loadMcpSurface } from '#surfaces/index.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { inspectDeclaredModels, inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { connectConfiguredModel } from '#composition/core/model-connect/index.js';
import { listConfiguredSecretNames } from '#composition/core/secrets/index.js';
import { inspectConfiguredToolchainCurrency, updateConfiguredToolchains } from '#composition/core/toolchains/index.js';
import { describeMcpInference } from './inference-query.js';
import { describeConfiguredOperationTools } from '#composition/core/operations/index.js';
import { applyConfiguredPoolCapacity, inspectConfiguredPoolCapacity, applyConfiguredPoolHold, inspectConfiguredPoolHold } from '#composition/core/runs/index.js';
import { inspectConfiguredDecision } from '#composition/core/decision/index.js';
/** Stdio peer inherits this local OS user's identity. This entry is not a remote authentication mechanism. */
export async function main(root = process.cwd()) {
  await loadConfiguredInstallationIdentity(root); const config = await loadComposedConfig(root, { heal: false });
  const locale = resolveLocale(undefined, process.env, config.language);
  const runtime = createConfiguredRuntimeClient(root), { createMcpServer } = await loadMcpSurface();
  // Catalog operations run on the service (runtime client handlers); their tool hints come from this installation's reachable catalog.
  const operationCatalog = await describeConfiguredOperationTools(root);
  return serveStdio(() => createMcpServer({ ...runtime, operationCatalog, inspectDeclaredModels: () => inspectDeclaredModels(root),
    inspectDecision: query => inspectConfiguredDecision(root, query),
    inspectModelBinding: reference => inspectModelBinding(root, reference),
    inspectToolchainCurrency: () => inspectConfiguredToolchainCurrency(root),
    updateToolchains: input => updateConfiguredToolchains(root, input),
    inspectModelInvocation: (query, delivery) => runtime.inspectModelInvocation(query, delivery),
    purgeModelInvocationContent: (command, delivery) => runtime.purgeModelInvocationContent(command, delivery),
    cancelModelInvocation: (command, delivery) => runtime.cancelModelInvocation(command, delivery),
    invokeModel: (command, delivery) => runtime.invokeModel(command, delivery),
    inspectProviderSpendAccount: (query, delivery) => runtime.inspectProviderSpendAccount(query, delivery),
    manageProviderSpend: (command, delivery) => runtime.manageProviderSpend(command, delivery),
    auditProviderSpendAccount: (command, delivery) => runtime.auditProviderSpendAccount(command, delivery),
    inspectModelActivation: query => inspectConfiguredModelActivation(root, query),
    admitModelActivation: command => admitConfiguredModelActivation(root, command), inspectModelCatalog: query => inspectConfiguredModelCatalog(root, query), applyModelCatalog: command => applyConfiguredModelCatalog(root, command),
    connectModel: command => connectConfiguredModel(root, command, {}, { listSecretNames: listConfiguredSecretNames }),
    applyPoolCapacity: command => applyConfiguredPoolCapacity(root, command), inspectPoolCapacity: query => inspectConfiguredPoolCapacity(root, query),
    inspectPoolHold: query => inspectConfiguredPoolHold(root, query), applyPoolHold: command => applyConfiguredPoolHold(root, command),
    inferencePlan: input => describeMcpInference(root, 'plan', input.profileId),
    inferenceBudget: input => describeMcpInference(root, 'budget', input.profileId) }, { maxConcurrentCalls: config.mcp.maxConcurrentCalls, responseMaxBytes: config.mcp.responseMaxBytes }, locale), {
    transport: createBoundedMcpTransport(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: config.mcp.inputMaxBytes }),
      { responseMaxBytes: config.mcp.responseMaxBytes }),
    onerror: () => { process.stderr.write('MCP_TRANSPORT_FAILED\n'); },
  });
}
/** Shared argument contract for Core and a distribution executable using `deckent/extensions`. */
export async function run(argv: readonly string[] = process.argv.slice(2)) {
  const { values } = parseArgs({ args: [...argv], options: { project: { type: 'string' } }, strict: true, allowPositionals: false });
  if (values.project !== undefined && !values.project.trim()) throw new Error('MCP_PROJECT_INVALID');
  return main(resolve(values.project ?? process.cwd()));
}
if (isMainModule(import.meta)) {
  void run().catch(() => { process.stderr.write('MCP_START_FAILED\n'); process.exitCode = 1; });
}
