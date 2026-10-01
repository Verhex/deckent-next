import type { MonitorCommandContext, WorkerTranscriptHandler } from '#surfaces/core/monitor/index.js';
import type { RunAdmissionHandler, RunDeliveryAdmissionHandler, RunCancellationDeliveryHandler, RunQueryHandler, RunReservationHandler } from './run.js';
import type { CodingProfilePreparationHandler } from './coding.js';
import type { Readable } from 'node:stream';
import type { TaskIntegrationDeliverHandler, TaskIntegrationInspectHandler, TaskIntegrationCheckHandler, TaskIntegrationPrepareHandler, TaskPatchHandler, TaskEvaluationHandler, TaskExecutionHandler } from './task.js';
import { getPolicyVocabulary } from '#engine/index.js';
import type { RuntimeServiceDescribeHandler, RuntimeServiceShutdownHandler, RuntimeServiceStartHandler } from './runtime.js';
import type { InstallationPreviewHandler, InstallationInspectionHandler, InstallationApplyHandler, InstallationResumeHandler,
  PolicyTemplatePreviewHandler, PolicyTemplateApplyHandler } from './init.js';
import type { ToolchainCurrencyReport, ModelInvocationDeliveryFinding } from '#engine/index.js';
import {
  configDisplayView, inspectProductPaths, getConfigFieldDefault, ErrorRegistry, loadConfig, getConfigValue,
  resolveGlobalScopePaths, normalizeGlobalScopePlatform, getSystemProfile,
  detectHostMemory, detectEnvironment, resolveLocalOsPrincipal,
  assertActorAssurance, principalToActor, resolveLocale, t, formatValue, emit,
  type ConfigLoadOptions, type OutputMode, type OutputSink, type Locale,
} from '#platform/index.js';

import type { TerminalChatPlanHandler, TerminalChatStreamHandler, TerminalChatTurnHandler, TerminalMentionAttachHandler, TerminalMentionFindHandler,
  TerminalPermissionModeInspectHandler, TerminalPermissionModeSetHandler, TerminalScratchClearHandler, TerminalScratchInspectHandler } from './terminal-chat.js';

import type { ModelCommandContext } from '#surfaces/core/cli-models/index.js';
export type { InferenceMetricsReading } from '#surfaces/core/cli-models/index.js';

import type { ShutdownCommand, ServiceShutdownAdmissionResult } from '#engine/index.js';
import type { ComposerHistoryPort } from '#surfaces/core/terminal-composer/index.js';
import type { TerminalSessionStoreView } from '#surfaces/core/terminal/index.js';

export interface RuntimeServiceReadinessView {
  readonly mode: 'connected' | 'started'; readonly instanceId: string; readonly pid: number | null; readonly logPath: string | null;
  readonly shutdownAvailable: boolean; readonly build: { readonly sourceTreeSha256: string; readonly sourceCommit: string | null } | null;
}

/** Every host operation a CLI command may use; the model commands' narrower context is part of it. */
export interface CommandContext extends ModelCommandContext, MonitorCommandContext {
  renewApproval?: (input: unknown) => Promise<unknown>;
  listApprovals?: (input: unknown) => Promise<unknown>;
  inspectApproval?: (input: unknown) => Promise<unknown>;
  decideApproval?: (input: unknown) => Promise<unknown>;
  deliverWorkspaceIntegration?: TaskIntegrationDeliverHandler;
  executeOperation?: import('./operation.js').OperationEffectHandler;
  inspectWorkerTranscript?: WorkerTranscriptHandler;
  compensateOperation?: import('./operation.js').OperationEffectHandler;
  inspectOperation?: import('./operation.js').OperationInspectHandler;
  adoptWorkspaceIntegration?: import('./task.js').TaskIntegrationAdoptHandler;
  rollbackWorkspaceIntegration?: import('./task.js').TaskIntegrationRollbackHandler;
  inspectWorkspaceIntegration?: TaskIntegrationInspectHandler;
  checkWorkspaceIntegration?: TaskIntegrationCheckHandler;
  prepareWorkspaceIntegration?: TaskIntegrationPrepareHandler;
  inspectToolchainCurrency?: (root: string, options: ConfigLoadOptions) => Promise<ToolchainCurrencyReport>;
  ensureRuntimeService?: (root: string, options: ConfigLoadOptions) => Promise<RuntimeServiceReadinessView>;
  restartRuntimeService?: (root: string, options: ConfigLoadOptions) => Promise<RuntimeServiceReadinessView>;
  openTerminalHistory?: (root: string, options: ConfigLoadOptions) => Promise<ComposerHistoryPort | null>;
  openTerminalSessions?: (root: string, options: ConfigLoadOptions) => Promise<TerminalSessionStoreView | null>;
  stopRuntimeService?: (root: string, options: ConfigLoadOptions) => Promise<{ readonly command: ShutdownCommand; readonly result: ServiceShutdownAdmissionResult }>;
  updateToolchains?: import('./toolchains.js').ToolchainUpdateHandler;
  runMcpCommand?: import('./mcp.js').McpCommandHandler;
  prepareWorkspacePatch?: TaskPatchHandler;
  previewWorkspacePatch?: TaskPatchHandler;
  renderUnifiedDiff?: (path: string, before: string | null, after: string | null) => string;
  prepareCodingProfile?: CodingProfilePreparationHandler;
  completeTerminalChat?: TerminalChatTurnHandler;
  streamTerminalChat?: TerminalChatStreamHandler;
  findTerminalMentions?: TerminalMentionFindHandler;
  attachTerminalMentions?: TerminalMentionAttachHandler;
  inspectPermissionMode?: TerminalPermissionModeInspectHandler;
  setPermissionMode?: TerminalPermissionModeSetHandler;
  inspectScratch?: TerminalScratchInspectHandler;
  clearScratch?: TerminalScratchClearHandler;
  describeTerminalChatPlan?: TerminalChatPlanHandler;
  previewInstallation?: InstallationPreviewHandler;
  inspectInstallation?: InstallationInspectionHandler;
  applyInstallation?: InstallationApplyHandler;
  resumeInstallation?: InstallationResumeHandler;
  previewPolicyTemplateInstallation?: PolicyTemplatePreviewHandler;
  applyPolicyTemplateInstallation?: PolicyTemplateApplyHandler;
  // Doctor-only, read-soft (SCR-B): null on a missing/unsafe/custom policy, never a hard failure of `doctor`.
  listStandingGrants?: import('./policy-grants.js').StandingGrantsHandler;
  revokeStandingGrant?: import('./policy-grants.js').StandingRevokeHandler;
  inspectPolicyTemplate?: (root: string, options: ConfigLoadOptions) => Promise<{ readonly id: string; readonly version: number } | null>;
  // Doctor-only, read-soft, network-free (SESSION-RESULT-LIMIT-2026-09-28): [] when unwired or nothing is unfit.
  assessModelInvocationDelivery?: (root: string, options: ConfigLoadOptions) => Promise<readonly ModelInvocationDeliveryFinding[]>;
  // SECRET-K1 (owner S1): the active secret backend and its state; doctor-only, never a hard failure of doctor. `secret list` names only.
  inspectSecretStore?: import('./secret.js').SecretStoreInspectHandler;
  // REALM-NOTICE: the shell realm a call here gets and every sandbox provider passed over (read-only measurement); doctor-only.
  inspectShellRealm?: (root: string, options: ConfigLoadOptions) => Promise<ShellRealmDoctorView>;
  listSecretNames?: import('./secret.js').SecretNamesHandler;
  // SECRET-WRITE: `secret set|delete` through the runtime service (the socket peer is the principal; the `secret` policy cell decides).
  setSecret?: import('./secret.js').SecretSetHandler;
  deleteSecret?: import('./secret.js').SecretDeleteHandler;
  // K5 typed pool hold: `pool hold|resume|status` (local application, no runtime service needed).
  applyPoolHold?: import('./pool.js').PoolHoldApplyHandler;
  inspectPoolHold?: import('./pool.js').PoolHoldInspectHandler;
  createRun?: RunAdmissionHandler;
  createDeliveryRun?: RunDeliveryAdmissionHandler;
  stdin?: Readable & { isTTY?: boolean };
  inspectRun?: RunQueryHandler;
  deliverRunCancellation?: RunCancellationDeliveryHandler;
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
/** One realm resolution as doctor shows it (the adapter's `ShellRealmReport` shape; surfaces keep their own view). */
interface ShellRealmSelection { readonly selected: string | null; readonly marker: string | null; readonly notice: string | null; readonly code: string | null;
  readonly rejected: readonly { readonly kind: string; readonly reason: string }[] }
export interface ShellRealmDoctorView extends ShellRealmSelection { readonly mode: string; readonly preferSandbox: ShellRealmSelection | null }
/** The realm lines in the product's own sandbox words (the result marker, then the notice the live stream shows); no catalog text. */
function shellRealmLines(report: ShellRealmDoctorView): string[] {
  const lines = (view: ShellRealmSelection, label: string) => [`${view.marker ?? (view.selected === 'host' ? 'sandbox: host' : `sandbox: refused (${view.code ?? '-'})`)} [${label}]`,
    ...(view.notice ? [view.notice] : view.rejected.length ? [view.rejected.map(item => `${item.kind}: ${item.reason}`).join('; ')] : [])];
  return [...lines(report, `terminal.shell.realm ${report.mode}`), ...(report.preferSandbox ? lines(report.preferSandbox, 'prefer-sandbox (MCP default)') : [])];
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
  const [command, action, key] = args.positionals;
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
  if (command === 'config') {
    if (action === 'get') {
      if (args.dryRun || args.positionals.length > 3) throw ErrorRegistry.createError('CLI_USAGE');
      const config = await loadConfig(root, options);
      locale = resolveLocale(args.language, env, config.language); mode = config.output_mode;
      context.onLocale?.(locale);
      const display = configDisplayView(config);
      const value = key === undefined ? display : getConfigValue(display, key);
      output(value, data => formatValue(data));
      return;
    }
    throw ErrorRegistry.createError('CLI_USAGE');
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
  const data = { schemaVersion: 2, scope: 'kernel', platform, host, hostMemory: detectHostMemory(), environment: detectEnvironment(env),
    paths: resolveGlobalScopePaths(platform, env), principal,
    company: { companyId: config.company.id }, status: 'ready', policyTemplate, modelInvocationDelivery, secretStore, shellRealm,
    ...(toolchains ? { toolchains } : {}) };
  output(data, result => [t('doctor.host', { platform: result.platform, cpu: result.host.cpuCores, memory: result.host.totalMemMB,
    workers: result.host.recommendedMaxWorkers, company: result.company.companyId, principal: result.principal.id }, locale),
  ...(result.toolchains ? [t('doctor.toolchains.header', { mode: result.toolchains.mode, endpoint: result.toolchains.registryEndpoint ?? '-' }, locale),
    ...result.toolchains.providers.map(entry => t('doctor.toolchains.entry', { provider: entry.provider, status: entry.reason ? `${entry.status} (${entry.reason})` : entry.status,
      admitted: entry.admitted.length ? entry.admitted.map(item => item.version ?? item.cliVersion).join(', ') : '-', latest: entry.latest?.version ?? '-' }, locale))] : []),
  // SECRET-K1: the selected secret store and whether it can be read now (backend id, status and typed code only; never a value).
  ...(result.secretStore ? [t('doctor.secretStore', { backend: result.secretStore.backend, status: result.secretStore.status,
    codeSuffix: result.secretStore.code ? `, ${result.secretStore.code}` : '' }, locale)] : []),
  ...(result.shellRealm ? shellRealmLines(result.shellRealm) : [])].join('\n'));
  // modelInvocationDelivery is JSON-only for now, like policyTemplate: no human-text rendering yet.
}
