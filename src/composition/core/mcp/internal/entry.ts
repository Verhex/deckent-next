#!/usr/bin/env node
import { planRuntimeRun } from '#composition/core/run-planner/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { admitConfiguredModelActivation, applyConfiguredModelCatalog, inspectConfiguredModelActivation, inspectConfiguredModelCatalog,
  inspectConfiguredModelRoles } from '#composition/core/model-activation/index.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfiguredInstallationIdentity } from '#composition/core/scoped-request/index.js';
import { resolveLocale, isMainModule, DeckentError, formatHumanError, loadConfigLanguage, t, type Locale } from '#platform/index.js';
import { withMcpPrincipal, createBoundedMcpTransport } from '#adapters/index.js';
import { loadMcpSurface } from '#surfaces/index.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { inspectDeclaredModels, inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { connectConfiguredModel } from '#composition/core/model-connect/index.js';
import { listConfiguredSecretNames } from '#composition/core/secrets/index.js';
import { inspectConfiguredToolchainCurrency, updateConfiguredToolchains } from '#composition/core/toolchains/index.js';
import { describeMcpInference } from './inference-query.js';
import { describeConfiguredOperationTools } from '#composition/core/operations/index.js';
import { releaseConfiguredQuota, applyConfiguredRunLifecycle, applyConfiguredPoolCapacity, inspectConfiguredPoolCapacity, applyConfiguredPoolHold, inspectConfiguredPoolHold } from '#composition/core/runs/index.js';
import { recordConfiguredMcpIngress } from './ingress.js';
import { inspectConfiguredDecision } from '#composition/core/decision/index.js';
import { inspectConfiguredMemory, listConfiguredMemory, searchConfiguredMemory } from '#composition/core/memory/index.js';
import { listConfiguredAgents, inspectConfiguredAgent, listConfiguredSkills, inspectConfiguredSkill, inspectConfiguredAgentStats } from '#composition/core/agent-catalog/index.js';
import { inspectConfiguredPolicyAdministration } from '#composition/core/approvals/index.js';
import { verifyConfiguredAudit } from '#composition/core/audit/index.js';
import { inspectMonitor } from '#composition/core/monitor/index.js';
/** Every handler, including direct configured writes, runs as the distinct MCP actor. */ export const mcpApplications = <T extends object>(applications: T): T => Object.fromEntries(Object.entries(applications).map(([name, value]) =>
  [name, typeof value === 'function' ? (...args: unknown[]) => withMcpPrincipal(() => Reflect.apply(value, applications, args)) : value])) as T;
/** Stdio verifies the local OS user but delegates no terminal-owner authority to the client. */ export async function main(root = process.cwd()) {
  await loadConfiguredInstallationIdentity(root); const config = await loadComposedConfig(root, { heal: false });
  const locale = resolveLocale(undefined, process.env, config.language);
  const runtime = createConfiguredRuntimeClient(root), { createMcpServer } = await loadMcpSurface();
  /* Catalog operations run on the service (runtime client handlers); their tool hints come from this installation's reachable catalog. */ const operationCatalog = await describeConfiguredOperationTools(root);
  return serveStdio(() => createMcpServer(mcpApplications({ ...runtime, operationCatalog, inspectDeclaredModels: () => inspectDeclaredModels(root),
    planRun: input => planRuntimeRun(root, input),
    recordModelIngress: (notice, input) => recordConfiguredMcpIngress(root, notice, input),
    applyRunControl: command => applyConfiguredRunLifecycle(root, command),
    inspectDecision: query => inspectConfiguredDecision(root, query, { heal: false }),
    listAgents: query => listConfiguredAgents(root, query, { heal: false }), inspectAgent: query => inspectConfiguredAgent(root, query, { heal: false }),
    listSkills: query => listConfiguredSkills(root, query, { heal: false }), inspectSkill: query => inspectConfiguredSkill(root, query, { heal: false }), inspectAgentStats: query => inspectConfiguredAgentStats(root, query, { heal: false }),
    listMemory: query => listConfiguredMemory(root, query, { heal: false }), searchMemory: query => searchConfiguredMemory(root, query, { heal: false }), inspectMemory: query => inspectConfiguredMemory(root, query, { heal: false }),
    inspectPolicyAdministration: query => inspectConfiguredPolicyAdministration(root, query, { heal: false }),
    verifyAudit: query => verifyConfiguredAudit(root, query),
    inspectMonitor: query => inspectMonitor(root, {}, query),
    inspectModelBinding: reference => inspectModelBinding(root, reference),
    inspectToolchainCurrency: () => inspectConfiguredToolchainCurrency(root, { heal: false }),
    updateToolchains: input => updateConfiguredToolchains(root, input),
    inspectModelInvocation: (query, delivery) => runtime.inspectModelInvocation(query, delivery),
    purgeModelInvocationContent: (command, delivery) => runtime.purgeModelInvocationContent(command, delivery),
    cancelModelInvocation: (command, delivery) => runtime.cancelModelInvocation(command, delivery),
    invokeModel: (command, delivery) => runtime.invokeModel(command, delivery),
    inspectProviderSpendAccount: (query, delivery) => runtime.inspectProviderSpendAccount(query, delivery),
    manageProviderSpend: (command, delivery) => runtime.manageProviderSpend(command, delivery),
    auditProviderSpendAccount: (command, delivery) => runtime.auditProviderSpendAccount(command, delivery),
    inspectModelActivation: query => inspectConfiguredModelActivation(root, query, { heal: false }),
    admitModelActivation: command => admitConfiguredModelActivation(root, command), inspectModelCatalog: query => inspectConfiguredModelCatalog(root, query, { heal: false }), inspectModelRoles: query => inspectConfiguredModelRoles(root, query, { heal: false }), applyModelCatalog: command => applyConfiguredModelCatalog(root, command),
    connectModel: command => connectConfiguredModel(root, command, {}, { listSecretNames: listConfiguredSecretNames }),
    applyPoolCapacity: command => applyConfiguredPoolCapacity(root, command), inspectPoolCapacity: query => inspectConfiguredPoolCapacity(root, query, { heal: false }),
    releaseQuota: command => releaseConfiguredQuota(root, command), inspectPoolHold: query => inspectConfiguredPoolHold(root, query, { heal: false }), applyPoolHold: command => applyConfiguredPoolHold(root, command),
    inferencePlan: input => describeMcpInference(root, 'plan', input.profileId),
    inferenceBudget: input => describeMcpInference(root, 'budget', input.profileId) }), { maxConcurrentCalls: config.mcp.maxConcurrentCalls, responseMaxBytes: config.mcp.responseMaxBytes }, locale), {
    transport: createBoundedMcpTransport(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: config.mcp.inputMaxBytes }),
      { responseMaxBytes: config.mcp.responseMaxBytes }),
    onerror: () => { process.stderr.write('MCP_TRANSPORT_FAILED\n'); },
  });
}
/** Shared argument contract for Core and a distribution executable using `deckent/extensions`. */ export async function run(argv: readonly string[] = process.argv.slice(2)) {
  const { values } = parseArgs({ args: [...argv], options: { project: { type: 'string' } }, strict: true, allowPositionals: false });
  if (values.project !== undefined && !values.project.trim()) throw new Error('MCP_PROJECT_INVALID');
  return main(resolve(values.project ?? process.cwd()));
}
/** Presentation only (like the CLI host): the `--project` directory's configured `language`, read without healing or locks; unreadable or absent → undefined. */
export async function mcpConfigLanguage(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<Locale | undefined> {
  const at = argv.indexOf('--project'), project = at >= 0 && argv[at + 1] && !argv[at + 1]!.startsWith('-') ? argv[at + 1]! : undefined;
  try { return await loadConfigLanguage(resolve(project ?? process.cwd()), { env }); } catch { return undefined; }
}
/** Start-up failure on stderr (stdout carries the protocol): `MCP_START_FAILED`, then a typed Deckent error's localized message and code (identity or configuration that could not load); any other error stays the bare line. */
export const mcpStartFailureText = (error: unknown, env: NodeJS.ProcessEnv = process.env, configLanguage?: Locale): string => 'MCP_START_FAILED\n' + (error instanceof DeckentError ? `${formatHumanError(error, { locale: resolveLocale(undefined, env, configLanguage), env, isTTY: false })}\n` : '');
/** `--help`/`-h` anywhere is a request for usage, answered before the strict option parser (which would reject it as unknown). */
export const mcpHelpRequested = (argv: readonly string[]): boolean => argv.some(argument => argument === '--help' || argument === '-h');
export const mcpHelpText = (env: NodeJS.ProcessEnv = process.env, configLanguage?: Locale): string => `${t('mcp.help.text', {}, resolveLocale(undefined, env, configLanguage))}\n`;
if (isMainModule(import.meta) && mcpHelpRequested(process.argv.slice(2))) void mcpConfigLanguage(process.argv.slice(2)).then(language => process.stdout.write(mcpHelpText(process.env, language)));
else if (isMainModule(import.meta)) void run().catch(async (error: unknown) => { process.stderr.write(mcpStartFailureText(error, process.env, await mcpConfigLanguage(process.argv.slice(2)))); process.exitCode = 1; });
