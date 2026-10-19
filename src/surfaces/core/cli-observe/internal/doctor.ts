import {
  ErrorRegistry, loadConfig, resolveGlobalScopePaths, normalizeGlobalScopePlatform, getSystemProfile, describeWorkerRecommendation,
  detectHostMemory, detectEnvironment, resolveLocalOsPrincipal, assertActorAssurance, principalToActor, resolveLocale, assessNodeSupport, NODE_ENGINE_RANGE,
} from '#platform/index.js';
import { configServiceState } from '#engine/index.js';
import { renderDoctorReport } from '#surfaces/core/doctor/index.js';
import { assessPoolReadiness, poolReadinessLines } from '#surfaces/core/cli-admin/index.js';
import type { KernelCommandContext } from './context.js';
import type { KernelCall } from './kernel.js';

/** `deckent doctor`: the read-only installation report; it never updates, rebuilds or activates anything. */
export async function doctorCommand(call: KernelCall, context: KernelCommandContext): Promise<void> {
  const { args, root, env, options, output } = call;
  const [command] = args.positionals;
  if (command !== 'doctor' || args.positionals.length !== 1 || args.global || args.dryRun) throw ErrorRegistry.createError('CLI_USAGE');
  const config = await loadConfig(root, options);
  call.locale = resolveLocale(args.language, env, config.language); call.mode = config.output_mode;
  const locale = call.locale;
  context.onLocale?.(locale);
  const platform = normalizeGlobalScopePlatform(process.platform, env), host = getSystemProfile();
  const principal = resolveLocalOsPrincipal('cli');
  assertActorAssurance(principalToActor(principal), 'doctor', config.enforce_principal_assurance);
  // Explicit opt-in only: default doctor stays network-free; the report never updates, rebuilds or activates a worker.
  if (args.toolchains && !context.inspectToolchainCurrency) throw ErrorRegistry.createError('CLI_USAGE');
  const toolchains = args.toolchains ? await context.inspectToolchainCurrency!(root, options) : undefined;
  // SCR-B: a local, soft read (no template, no policy file, or an unsafe/custom one -> null); never blocks doctor.
  const policyScope = (config.terminal as { scopeId?: string } | undefined)?.scopeId;
  const policyAdministration = context.inspectPolicyAdministration && policyScope
    ? await context.inspectPolicyAdministration(root, { schemaVersion: 1, scopeId: policyScope }, options).catch(() => null) : null;
  const auditIntegrity = context.verifyAudit && policyScope ? await context.verifyAudit(root, { schemaVersion: 1, scopeId: policyScope }, options).catch(() => ({ schemaVersion: 1 as const, scopeId: policyScope, status: 'unknown' as const, reason: 'unavailable' as const, head: null, checkpoint: null })) : null;
  const policyTemplate = context.inspectPolicyTemplate ? await context.inspectPolicyTemplate(root, options) : null;
  // SESSION-RESULT-LIMIT-2026-09-28: unconditional like policyTemplate (nobody was looking at the line-mode/MCP path
  // before this); [] when unwired or every declared profile fits. Read-only, network-free, never blocks doctor.
  const modelInvocationDelivery = context.assessModelInvocationDelivery
    ? await context.assessModelInvocationDelivery(root, options) : [];
  // SECRET-K1: additive; null when unwired. The configuration is read for the selection only (no reference resolved for this report).
  const secretStore = context.inspectSecretStore ? await context.inspectSecretStore(root, options) : null;
  // REALM-NOTICE: additive; null when unwired. The measurement itself is bounded and never throws (a failed probe reads `unknown`).
  const shellRealm = context.inspectShellRealm ? await context.inspectShellRealm(root, options) : null;
  const imageRefresh = context.inspectToolchainRefresh ? await context.inspectToolchainRefresh(root, options).catch(() => null) : null;
  // Read-soft: whether the running service still uses the restart-apply configuration now on disk (null when it cannot be asked).
  const serviceConfig = await configServiceState(root, options, context.describeRuntimeService);
  const installationBinding = context.inspectInstallationBinding ? await context.inspectInstallationBinding(root, options) : null;
  const recoveryFiles = context.inspectRecoveryFiles ? await context.inspectRecoveryFiles(root, options).catch(() => null) : null;
  const poolReadiness = await assessPoolReadiness(root, context, options, config.admission, (config.terminal as { scopeId?: string } | undefined)?.scopeId);
  const startability = context.inspectInstallationStartability ? await context.inspectInstallationStartability(root, { ...options, env: { ...env, DECKENT_LANGUAGE: locale } }) : null;
  const node = assessNodeSupport(process.version, NODE_ENGINE_RANGE);
  const data = { schemaVersion: 2, scope: 'kernel', platform, host: { ...host, workerBasis: describeWorkerRecommendation(host.freeMemMB, host.cpuCores) }, hostMemory: detectHostMemory(), environment: detectEnvironment(env),
    paths: resolveGlobalScopePaths(platform, env), principal,
    company: { companyId: config.company.id }, node, auditIntegrity, startability, status: node.status === 'unsupported' || (auditIntegrity && auditIntegrity.status !== 'match') || startability?.status === 'blocked' || poolReadiness.status === 'drift' || poolReadiness.status === 'unavailable' || shellRealm?.selfTest?.status === 'failed' ? 'degraded' as const : 'ready' as const, poolReadiness, policyTemplate, policyAdministration, modelInvocationDelivery, secretStore, shellRealm, imageRefresh, installationBinding, serviceConfig, recoveryFiles,
    ...(toolchains ? { toolchains } : {}) };
  output(data, result => renderDoctorReport(result, result.poolReadiness ? poolReadinessLines(result.poolReadiness, locale) : [], locale));
  if (startability?.status === 'blocked') throw ErrorRegistry.createError('INSTALLATION_NOT_STARTABLE');
}
