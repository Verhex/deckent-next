import {
  ErrorRegistry, loadConfig, resolveGlobalScopePaths, normalizeGlobalScopePlatform, getSystemProfile, describeWorkerRecommendation,
  detectHostMemory, detectEnvironment, resolveLocalOsPrincipal, assertActorAssurance, principalToActor, resolveLocale, assessNodeSupport, NODE_ENGINE_RANGE, t,
  type ConfigLoadOptions,
} from '#platform/index.js';
import { configServiceState } from '#engine/index.js';
import { DOCTOR_BACKUP_PASSPHRASE_SECRET, DOCTOR_RETIREMENT_STATES, doctorChecks, renderDoctorChecks, renderDoctorReport, type DoctorCheckFacts } from '#surfaces/core/doctor/index.js';
import { assessPoolReadiness, poolReadinessLines } from '#surfaces/core/cli-admin/index.js';
import { modelRetirementWarnings } from '#surfaces/core/cli-models/index.js';
import type { KernelCommandContext } from './context.js';
import type { KernelCall } from './kernel.js';
import { offerDoctorFixes } from './doctor-fix.js';

type DoctorConfig = Awaited<ReturnType<typeof loadConfig>>;

/** Facts only the grouped view needs: each is read-soft (a failed read is "not tested"), secret names only, never a value. */
async function checkFacts(root: string, config: DoctorConfig, context: KernelCommandContext, options: ConfigLoadOptions, toolchainsRequested: boolean,
  poolStatus: DoctorCheckFacts['poolStatus']): Promise<DoctorCheckFacts> {
  const scopeId = (config.terminal as { scopeId?: string } | undefined)?.scopeId ?? null;
  const identity = (config as Record<string, unknown>)['identity'] as { profile?: { id?: unknown } } | undefined;
  const names = context.listSecretNames ? await context.listSecretNames(root, options).then(view => view.names, () => null) : null;
  const catalog = context.inspectModelCatalog && scopeId ? await context.inspectModelCatalog(root, { schemaVersion: 1, scopeId }, options).catch(() => null) : null;
  const recoveryMode = context.inspectRecoveryMode && scopeId ? await context.inspectRecoveryMode(root, { schemaVersion: 1, scopeId }, options).catch(() => null) : null;
  const roles = context.inspectModelRoles && scopeId ? await context.inspectModelRoles(root, { schemaVersion: 1, scopeId }, options).catch(() => null) : null;
  const executionEnvironment = context.inspectExecutionEnvironment ? await context.inspectExecutionEnvironment(options.env ?? process.env).catch(() => null) : null;
  const docker = config.execution?.docker, workerImage = docker && executionEnvironment?.state === 'done' && context.inspectWorkerImage
    ? await context.inspectWorkerImage({ executable: docker.executable, imageId: docker.imageId, timeoutMs: docker.controlTimeoutMs, outputBytes: docker.outputBytes }).catch(() => 'unknown' as const) : null;
  // PRE-8 v2: the one inventory (names only): used keys without a grant, undeclared project keys, declared keys not stored, used keys stored nowhere.
  const inventory = context.inspectSecretInventory && scopeId ? await context.inspectSecretInventory(root, { scopeId, all: false }, options).catch(() => null) : null;
  const secretUse = inventory === null ? null : [...inventory.findings.map(finding => ({ kind: finding.kind, name: finding.name })),
    ...inventory.rows.filter(row => row.vault === 'main' && row.usedBy.length > 0 && row.presence === 'missing' && row.grant.state === 'granted').map(row => ({ kind: 'not-stored' as const, name: row.name }))];
  return {
    scopeId, toolchainsRequested, poolStatus, toolchainUpdateEnabled: config.toolchains.update.mode !== 'off',
    firstJob: { execution: !!docker && workerImage !== 'missing', registry: !!config.admission?.registry }, // I-S7: the first-job steps doctor names
    imageId: docker?.imageId ?? null, executionEnvironment, workerImage,
    identityProfile: typeof identity?.profile?.id === 'string' ? { state: 'selected', id: identity.profile.id } : { state: 'missing' },
    backupPassphraseStored: names === null ? null : names.includes(DOCTOR_BACKUP_PASSPHRASE_SECRET),
    retiringModels: catalog === null ? null : retiringModels(catalog, config.models.retirementWarningDays), secretUse,
    recoveryMode,
    pendingRoleModels: roles === null ? null : roles.models.filter(entry => entry.state === 'pending').map(entry => ({ modelId: entry.modelId, channelId: entry.channelId })),
    headlessLogins: context.readHeadlessLogins && scopeId ? await context.readHeadlessLogins((config as Record<string, unknown>)['provider_invocation_profiles'], scopeId, options).catch(() => null) : null,
  };
}

/** Active models past `active` in the catalog lifecycle, joined (J2e, delta C-MODELS-for-C-DOCTOR) with the `models` table's own warning rule: a
 * switched-on model whose retirement day is within `models.retirementWarningDays` (config field, law 6), so doctor and `deckent models` agree. */
function retiringModels(catalog: NonNullable<Awaited<ReturnType<NonNullable<KernelCommandContext['inspectModelCatalog']>>>>, days: number) {
  const byState = catalog.channels.flatMap(channel => channel.access === 'denied' ? [] : channel.models
    .filter(entry => entry.activation?.state === 'active' && DOCTOR_RETIREMENT_STATES.includes(entry.model.lifecycle.state))
    .map(entry => ({ modelId: entry.modelId, channelId: channel.channelId, state: entry.model.lifecycle.state,
      date: entry.model.lifecycle.retiredOn ?? entry.model.lifecycle.retireNotBefore ?? null })));
  const seen = new Set(byState.map(item => `${item.channelId}/${item.modelId}`));
  const byDay = modelRetirementWarnings(catalog, Date.now(), days).filter(warning => !seen.has(`${warning.channelId}/${warning.modelId}`))
    .map(warning => ({ modelId: warning.modelId, channelId: warning.channelId, state: warning.daysLeft <= 0 ? 'retired' : 'deprecated', date: warning.day }));
  return [...byState, ...byDay];
}

/** One measurement: the collected report (the `--json` contract, unchanged) and the grouped rows the person reads. */
async function measure(call: KernelCall, context: KernelCommandContext) {
  const { args, root, env } = call;
  // C-DOCTOR: doctor only reads. A corrupt project config is reported (CONFIG_FILE_INVALID), never "healed" (rewritten) by a health check.
  const options: ConfigLoadOptions = { ...call.options, heal: false };
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
  const checks = doctorChecks(data, await checkFacts(root, config, context, options, args.toolchains, poolReadiness.status), locale);
  return { data, checks, config, options };
}

/** I-S3: `deckent init`'s final check reads the same measurement as the grouped view (read-only, heal:false), never printing or offering a fix:
 * any error row → errors, else any warning row → warnings, else ok ("not tested" rows count as neither, as in the doctor summary). */
export async function doctorVerdict(root: string, context: KernelCommandContext, options: ConfigLoadOptions): Promise<'ok' | 'warnings' | 'errors'> {
  const env = options.env ?? process.env, call: KernelCall = { args: { positionals: ['doctor'], json: true, global: false, dryRun: false, toolchains: false, verbose: false },
    root, env, options: { env }, locale: 'en', mode: 'json', output: () => undefined };
  const { checks } = await measure(call, context);
  return checks.some(check => check.state === 'error') ? 'errors' : checks.some(check => check.state === 'warning') ? 'warnings' : 'ok';
}

/**
 * `deckent doctor`: the read-only installation report, grouped (Kurulum / Güvenlik / Çalışma / Araçlar) with one next step per warning;
 * internals behind `--verbose`, the collected report (unchanged contract) with `--json`. On a person's terminal a fixable row is offered as
 * a card and applied only through an existing product operation after the person confirms; pipe, agent and `--json` callers are never asked.
 */
export async function doctorCommand(call: KernelCall, context: KernelCommandContext): Promise<void> {
  const { args, output } = call;
  const [command] = args.positionals;
  if (command !== 'doctor' || args.positionals.length !== 1 || args.global || args.dryRun) throw ErrorRegistry.createError('CLI_USAGE');
  const show = (measured: Awaited<ReturnType<typeof measure>>) => output(measured.data, result => {
    const grouped = renderDoctorChecks(measured.checks, call.locale);
    return args.verbose ? [grouped, '', t('doctor.details', {}, call.locale),
      renderDoctorReport(result, result.poolReadiness ? poolReadinessLines(result.poolReadiness, call.locale) : [], call.locale,
        { status: false, imageId: measured.config.execution?.docker?.imageId ?? null })].join('\n') : grouped;
  });
  let measured = await measure(call, context);
  show(measured);
  if (measured.data.startability?.status === 'blocked') throw ErrorRegistry.createError('INSTALLATION_NOT_STARTABLE');
  if (args.json || call.mode === 'json') return;
  // Each applied fix is followed by a fresh measurement; each registry fix is offered at most once per call (bounded).
  await offerDoctorFixes({ checks: () => measured.checks, locale: call.locale, root: call.root, options: measured.options, config: measured.config, context,
    remeasure: async () => { measured = await measure(call, context); show(measured); } });
}
