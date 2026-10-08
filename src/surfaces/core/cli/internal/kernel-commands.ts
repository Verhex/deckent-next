import type { IdentityCommandContext } from '#surfaces/core/cli-identity/index.js';
import { assessPoolReadiness, poolReadinessLines } from './pool.js';
import type { RunAdmissionHandler, RunDeliveryAdmissionHandler, RunReservationHandler } from './run.js';
import type { CodingProfilePreparationHandler } from './coding.js';
import type { Readable } from 'node:stream';
import type { TaskIntegrationDeliverHandler, TaskIntegrationInspectHandler, TaskIntegrationCheckHandler, TaskIntegrationPrepareHandler, TaskPatchHandler, TaskEvaluationHandler, TaskExecutionHandler } from './task.js';
import { getPolicyVocabulary } from '#engine/index.js';
import type { RuntimeServiceDescribeHandler, RuntimeServiceShutdownHandler, RuntimeServiceStartHandler } from './runtime.js';
import type { InstallationCommandContext } from '#surfaces/core/cli-installation/index.js';
import type { ToolchainCurrencyReport, ModelInvocationDeliveryFinding } from '#engine/index.js';
import {
  inspectProductPaths, getConfigFieldDefault, ErrorRegistry, loadConfig,
  resolveGlobalScopePaths, normalizeGlobalScopePlatform, getSystemProfile,
  detectHostMemory, detectEnvironment, resolveLocalOsPrincipal,
  assertActorAssurance, principalToActor, resolveLocale, formatValue, emit,
  type ConfigLoadOptions, type OutputMode, type OutputSink, type Locale,
} from '#platform/index.js';

import type { TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
export type { RuntimeServiceReadinessView } from '#surfaces/core/cli-terminal/index.js';

import { renderDoctorReport, type InstallationBindingReport, type ShellRealmDoctorView } from '#surfaces/core/doctor/index.js';
export type { InstallationBindingReport, ShellRealmDoctorView } from '#surfaces/core/doctor/index.js';
import type { ModelCommandContext } from '#surfaces/core/cli-models/index.js';
import type { DecisionCommandContext } from '#surfaces/core/cli-decision/index.js';
export type { InferenceMetricsReading } from '#surfaces/core/cli-models/index.js';

import { configServiceState, type ShutdownCommand, type ServiceShutdownAdmissionResult } from '#engine/index.js';

/** Every host operation a CLI command may use; the model commands' narrower context is part of it. */
export type RunLifecycleHandler = (root: string, input: import('#engine/index.js').RunLifecycleCommand, options: ConfigLoadOptions) => Promise<{ readonly schemaVersion: 1; readonly layout: import('#platform/index.js').ProductLayout; readonly lifecycle: { readonly schemaVersion: 1; readonly commandId: string; readonly run: import('#engine/index.js').RunView } } | null>;
/** The terminal's slice (TERMINAL-LAUNCH) carries the monitor and config command contexts. */
export interface CommandContext extends InstallationCommandContext, IdentityCommandContext, ModelCommandContext, DecisionCommandContext, TerminalLaunchContext {
  executeBackup?: import('./backup.js').BackupHandler;
  applyRunLifecycle?: RunLifecycleHandler;
  renewApproval?: (input: unknown) => Promise<unknown>;
  inspectApproval?: (input: unknown) => Promise<unknown>;
  deliverWorkspaceIntegration?: TaskIntegrationDeliverHandler;
  executeOperation?: import('./operation.js').OperationEffectHandler;
  compensateOperation?: import('./operation.js').OperationEffectHandler;
  inspectOperation?: import('./operation.js').OperationInspectHandler;
  adoptWorkspaceIntegration?: import('./task.js').TaskIntegrationAdoptHandler;
  rollbackWorkspaceIntegration?: import('./task.js').TaskIntegrationRollbackHandler;
  inspectWorkspaceIntegration?: TaskIntegrationInspectHandler;
  checkWorkspaceIntegration?: TaskIntegrationCheckHandler;
  prepareWorkspaceIntegration?: TaskIntegrationPrepareHandler;
  inspectToolchainCurrency?: (root: string, options: ConfigLoadOptions) => Promise<ToolchainCurrencyReport>;
  stopRuntimeService?: (root: string, options: ConfigLoadOptions) => Promise<{ readonly command: ShutdownCommand; readonly result: ServiceShutdownAdmissionResult }>;
  updateToolchains?: import('./toolchains.js').ToolchainUpdateHandler;
  runMcpCommand?: import('./mcp.js').McpCommandHandler;
  prepareWorkspacePatch?: TaskPatchHandler;
  previewWorkspacePatch?: TaskPatchHandler;
  renderUnifiedDiff?: (path: string, before: string | null, after: string | null) => string;
  prepareCodingProfile?: CodingProfilePreparationHandler;
  // Doctor-only, read-soft (SCR-B): null on a missing/unsafe/custom policy, never a hard failure of `doctor`.
  listStandingGrants?: import('./policy-grants.js').StandingGrantsHandler;
  revokeStandingGrant?: import('./policy-grants.js').StandingRevokeHandler;
  upgradePolicyTemplate?: import('./policy-grants.js').PolicyUpgradeHandler;
  inspectPolicyTemplate?: (root: string, options: ConfigLoadOptions) => Promise<{ readonly id: string; readonly version: number } | null>;
  // Doctor-only, read-soft, network-free (SESSION-RESULT-LIMIT-2026-09-28): [] when unwired or nothing is unfit.
  assessModelInvocationDelivery?: (root: string, options: ConfigLoadOptions) => Promise<readonly ModelInvocationDeliveryFinding[]>;
  // SECRET-K1 (owner S1): the active secret backend and its state; doctor-only, never a hard failure of doctor. `secret list` names only.
  inspectSecretStore?: import('./secret.js').SecretStoreInspectHandler;
  // S1 D4: files an interrupted backup restore left behind; doctor-only, read-soft (null when unwired or unreadable).
  inspectRecoveryFiles?: (root: string, options: ConfigLoadOptions) => Promise<import('#surfaces/core/doctor/index.js').RecoveryFilesDoctorView>;
  // REALM-NOTICE: the shell realm a call here gets and every sandbox provider passed over (read-only measurement); doctor-only.
  inspectShellRealm?: (root: string, options: ConfigLoadOptions) => Promise<ShellRealmDoctorView>;
  // WORKER-AUTO-REFRESH: the worker image refresh status (updating / current / failed with a typed reason); doctor-only, local file read, null when unwired or never run.
  inspectToolchainRefresh?: (root: string, options: ConfigLoadOptions) => Promise<{ readonly status: string; readonly reason: string | null; readonly imageVersion: string | null } | null>;
  // Doctor-only, read-soft: whether the installation identity can be bound to this machine (relocation/copy detection); null when unwired or unreadable.
  inspectInstallationBinding?: (root: string, options: ConfigLoadOptions) => Promise<InstallationBindingReport | null>;
  listSecretNames?: import('./secret.js').SecretNamesHandler;
  // SECRET-WRITE: `secret set|delete` through the runtime service (the socket peer is the principal; the `secret` policy cell decides).
  setSecret?: import('./secret.js').SecretSetHandler;
  deleteSecret?: import('./secret.js').SecretDeleteHandler;
  // SECRET-STORE-SWITCH (v24): the stores for the picker and the governed switch through the runtime service (`secret`/`switch`).
  listSecretStores?: import('./secret-store.js').SecretStoresHandler;
  switchSecretStore?: import('./secret-store.js').SecretStoreSwitchHandler;
  // K5 typed pool hold: `pool hold|resume|status` (local application, no runtime service needed).
  applyPoolCapacity?: import('./pool.js').PoolCapacityApplyHandler;
  inspectPoolCapacity?: import('./pool.js').PoolCapacityInspectHandler;
  applyPoolHold?: import('./pool.js').PoolHoldApplyHandler;
  inspectPoolHold?: import('./pool.js').PoolHoldInspectHandler;
  createRun?: RunAdmissionHandler;
  createDeliveryRun?: RunDeliveryAdmissionHandler;
  stdin?: Readable & { isTTY?: boolean };
  reserveRunTasks?: RunReservationHandler;
  executeTask?: TaskExecutionHandler;
  evaluateTask?: TaskEvaluationHandler;
  startRuntimeService?: RuntimeServiceStartHandler;
  describeRuntimeService?: RuntimeServiceDescribeHandler;
  shutdownRuntimeService?: RuntimeServiceShutdownHandler;
  signal?: AbortSignal;
  initialize?: () => void;
  root?: string; env?: NodeJS.ProcessEnv; stdout?: OutputSink; stderr?: OutputSink;
  onLocale?: (locale: Locale) => void;
}
interface Parsed { positionals: string[]; json: boolean; global: boolean; dryRun: boolean; toolchains: boolean; language?: string }
function parse(argv: readonly string[]): Parsed {
  const result: Parsed = { positionals: [], json: false, global: false, dryRun: false, toolchains: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') result.json = true;
    else if (arg === '--global') result.global = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--toolchains') result.toolchains = true;
    else if (arg === '--no-color') continue;
    else if (arg === '--lang') {
      const language = argv[++i];
      if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      result.language = language;
    } else if (arg.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
    else result.positionals.push(arg);
  }
  return result;
}
export async function runKernelCommand(argv: readonly string[], context: CommandContext = {}): Promise<void> {
  const args = parse(argv), root = context.root ?? process.cwd(), env = context.env ?? process.env;
  const [command, action] = args.positionals;
  if (args.toolchains && command !== 'doctor') throw ErrorRegistry.createError('CLI_USAGE');
  let locale = resolveLocale(args.language, env);
  context.onLocale?.(locale);
  let mode: OutputMode = getConfigFieldDefault('output_mode');
  function output<T>(data: T, render: (data: T) => string, level: 'info' | 'warning' = 'info') {
    emit(data, { json: args.json, mode, level, render, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
  }
  const options: ConfigLoadOptions = { env, globalOnly: args.global,
    onWarning: warning => output(warning, value => value.message, 'warning') };
  if (command === 'policy') {
    if (action !== 'vocabulary' || args.positionals.length !== 2 || args.global || args.dryRun) throw ErrorRegistry.createError('CLI_USAGE');
    output(getPolicyVocabulary(), data => formatValue(data));
    return;
  }
  if (command === 'paths') {
    if (args.dryRun || args.positionals.length !== 1) throw ErrorRegistry.createError('CLI_USAGE');
    output(await inspectProductPaths(root, { ...options, globalOnly: args.global }), data => formatValue(data));
    return;
  }
  if (command !== 'doctor' || args.positionals.length !== 1 || args.global || args.dryRun) throw ErrorRegistry.createError('CLI_USAGE');
  const config = await loadConfig(root, options);
  locale = resolveLocale(args.language, env, config.language); mode = config.output_mode;
  context.onLocale?.(locale);
  const platform = normalizeGlobalScopePlatform(process.platform, env), host = getSystemProfile();
  const principal = resolveLocalOsPrincipal('cli');
  assertActorAssurance(principalToActor(principal), 'doctor', config.enforce_principal_assurance);
  // Explicit opt-in only: default doctor stays network-free; the report never updates, rebuilds or activates a worker.
  if (args.toolchains && !context.inspectToolchainCurrency) throw ErrorRegistry.createError('CLI_USAGE');
  const toolchains = args.toolchains ? await context.inspectToolchainCurrency!(root, options) : undefined;
  // SCR-B: a local, soft read (no template, no policy file, or an unsafe/custom one -> null); never blocks doctor.
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
  const data = { schemaVersion: 2, scope: 'kernel', platform, host, hostMemory: detectHostMemory(), environment: detectEnvironment(env),
    paths: resolveGlobalScopePaths(platform, env), principal,
    company: { companyId: config.company.id }, status: poolReadiness.status === 'drift' || poolReadiness.status === 'unavailable' ? 'degraded' : 'ready', poolReadiness, policyTemplate, modelInvocationDelivery, secretStore, shellRealm, imageRefresh, installationBinding, serviceConfig, recoveryFiles,
    ...(toolchains ? { toolchains } : {}) };
  output(data, result => renderDoctorReport(result, result.poolReadiness ? poolReadinessLines(result.poolReadiness, locale) : [], locale));
  // modelInvocationDelivery is JSON-only for now, like policyTemplate: no human-text rendering yet.
}
