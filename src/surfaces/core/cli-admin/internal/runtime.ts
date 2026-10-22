import { renderAuditReason } from '#surfaces/core/doctor/index.js';
import { ErrorRegistry, EXIT_CODES, emit, formatDuration, loadConfig, readBuildIdentity, t, terminalSafeText, type DeckentError, type ConfigLoadOptions, type ExitCode, type Locale, type ProductLayout } from '#platform/index.js';
import { configServiceState, shutdownCommandSchema, type CancellationRecoveryCommand, type CancellationRecoveryPageResult, type RuntimeServiceDescriptor,
  type RuntimeServiceDrainResult, type RunView, type ProgressionCursor, type ReconciliationRecoveryCommand, type ReconciliationRecoveryPage,
  type ServiceShutdownAdmissionResult, type ShutdownCommand, type BackupScheduleObserver } from '#engine/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { formatDuration as humanDuration } from '#surfaces/core/cli-human/index.js';
import type { AdminCommandContext } from './context.js';
import type { ENVIRONMENT_NOT_READY_CODE, ENVIRONMENT_TIMED_OUT_CODE, ENVIRONMENT_UNCERTAIN_CODE } from '#domain/index.js';
import { adminInteractive, adminSinks, askAdminCard, confirmOptions, reportCancelled } from './io.js';

/** The service journal line of a progression turn that stopped. PRE-7: an environment refusal parked the Run for its environment (an
 * installation defect, not a task failure); it is named so, with the requirement, never as "could not continue". JSON is unchanged. */
const ENVIRONMENT_NOT_READY: typeof ENVIRONMENT_NOT_READY_CODE = 'EXECUTION_ENVIRONMENT_NOT_READY', ENVIRONMENT_UNCERTAIN: typeof ENVIRONMENT_UNCERTAIN_CODE = 'EXECUTION_ENVIRONMENT_UNCERTAIN',
  ENVIRONMENT_TIMED_OUT: typeof ENVIRONMENT_TIMED_OUT_CODE = 'EXECUTION_ENVIRONMENT_TIMED_OUT';
export function runProgressionErrorText(query: Readonly<{ scopeId: string; runId: string }> | null | undefined,
  error: Pick<DeckentError, 'code'> & Partial<Pick<DeckentError, 'params' | 'localize' | 'message'>>, locale: Locale): string {
  const prefix = query ? `${query.scopeId}/${query.runId}: ` : '', requirement = error.params?.['requirement'];
  if (error.code === ENVIRONMENT_NOT_READY && typeof requirement === 'string') return prefix + t('cli.runtime.runParkedEnvironment', { requirement }, locale);
  if (error.code === ENVIRONMENT_UNCERTAIN && typeof requirement === 'string') return prefix + t('cli.runtime.runParkedEnvironmentUncertain', { requirement, probe: String(error.params?.['probe'] ?? '—') }, locale);
  // E1: a timed-out probe held the Run for an explicit re-run (no answer, not an installation defect).
  if (error.code === ENVIRONMENT_TIMED_OUT && typeof requirement === 'string') return prefix + t('cli.runtime.runHeldEnvironmentTimedOut', { requirement }, locale);
  return `${prefix}${t('cli.runtime.runProgressionFailed', { code: error.code }, locale)}: ${error.localize?.(locale).message ?? error.message ?? error.code}`;
}
export type PreflightSweep = Readonly<{ removed: number; unsettled: readonly string[]; unlisted?: true; released?: number; held?: readonly string[]; settlementFailed?: readonly Readonly<{ probes: readonly string[]; code?: string }>[] }>;
/** The start journal of the probe sweep and hold reconcile; each held probe is named with its real cause (PRE7FU, Astra 2700 P2): removal not
 * proven (`held`) or proven removed but the ledger release failed (`settlementFailed`, with its typed code). */
export function preflightSweptText(result: PreflightSweep, locale: Locale): string {
  const held = result.held ?? [];
  return [result.unlisted ? t('cli.runtime.preflightUnlisted', {}, locale) : result.unsettled.length
    ? t('cli.runtime.preflightUnsettled', { removed: result.removed, probes: result.unsettled.join(', ') }, locale) : t('cli.runtime.preflightSwept', { removed: result.removed }, locale),
  ...(result.released ? [t('cli.runtime.preflightReleased', { count: result.released }, locale)] : []), ...(held.length ? [t('cli.runtime.preflightHeld', { probes: held.join(', ') }, locale)] : []),
  ...(result.settlementFailed ?? []).map(failure => t('cli.runtime.preflightSettlementFailed', { probes: failure.probes.join(', '), code: failure.code ?? '—' }, locale))].join('\n');
}
export interface RuntimeServiceHost {
  readonly endpoint: string;
  readonly layout: ProductLayout;
  readonly done: Promise<void>;
  stop(): Promise<RuntimeServiceDrainResult>;
}
export interface RuntimeServiceObserver extends BackupScheduleObserver {
  onAuditIntegrity?(status: import('#engine/index.js').AuditServiceStatus): void | Promise<void>;
  onQueryFailure?(event: { readonly code: string; readonly diagnosticId: string; readonly detail: string }): void | Promise<void>;
  onPreflightProbesSwept?(result: PreflightSweep): void | Promise<void>;
  onRunProgression?(query: ProgressionCursor, result: Readonly<{ run: RunView; attempted: number; stopped: boolean; waitedForSlotMs?: number }>): void | Promise<void>;
  onRunProgressionError?(query: ProgressionCursor | null, error: Pick<DeckentError, 'code'> & Partial<Pick<DeckentError, 'params' | 'localize' | 'message'>>): void | Promise<void>;
  onReconciliationPage?(command: ReconciliationRecoveryCommand, result: ReconciliationRecoveryPage): void | Promise<void>;
  onReconciliationError?(command: ReconciliationRecoveryCommand, error: { readonly code: string }): void | Promise<void>;
  onPage(command: CancellationRecoveryCommand, result: CancellationRecoveryPageResult): void | Promise<void>;
  onError(command: CancellationRecoveryCommand, error: { readonly code: string }): void | Promise<void>;
  onLedgerUpgraded?(upgrade: Readonly<{ from: number; to: number; backupPath: string }>): void | Promise<void>;
  onToolCallApprovalsExpired?(result: Readonly<{ expired: number; failed: number; keyUnavailable: boolean }>): void | Promise<void>;
  onIdleShutdown?(event: Readonly<{ afterMs: number }>): void | Promise<void>;
  onToolchainRefresh?(event: Readonly<{ phase: 'started' | 'current' | 'failed' | 'unverified'; imageVersion: string | null; imageId: string | null; appliedProfiles: number; code: string | null }>): void | Promise<void>;
}
export type RuntimeServiceStartHandler = (root: string, observer: RuntimeServiceObserver, options: ConfigLoadOptions) => Promise<RuntimeServiceHost>;
export type RuntimeServiceDescribeHandler = (root: string, options: ConfigLoadOptions) => Promise<RuntimeServiceDescriptor>;
export type RuntimeServiceShutdownHandler = (root: string, command: ShutdownCommand, options: ConfigLoadOptions) => Promise<ServiceShutdownAdmissionResult>;
/** The files the product layout does not list (composition reads them; nothing is created): the real runtime socket, MCP definition files,
 * the selected secret store's files. */
export interface AdminPathsView { readonly schemaVersion: 1; readonly runtimeSocket: string | null; readonly mcp: Readonly<{ project: string; personal: string }> | null;
  readonly secretStore: Readonly<{ store: string; files: readonly string[] }> }
export type AdminPathsHandler = (root: string, options: ConfigLoadOptions) => Promise<AdminPathsView>;

/** What the service is running now, from the configured scope's pool (local ledger read; null when it cannot be read). */
async function runningWork(context: AdminCommandContext, root: string, options: ConfigLoadOptions) {
  const scopeId = await loadConfig(root, options).then(config => (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId, () => undefined);
  if (typeof scopeId !== 'string' || !context.inspectPoolHold) return null;
  return context.inspectPoolHold(root, { schemaVersion: 1, scopeId }, options).then(view => ({ scopeId, running: view.occupancy.execution,
    evaluating: Math.max(0, view.occupancy.inFlight - view.occupancy.execution) }), () => null);
}
/**
 * Owner CLI review 2026-10-19 (`runtime`), A48-D8: the status from what protocol v29 already carries — build (and whether it is this CLI's),
 * configuration freshness, running work, socket. No start time or uptime: the descriptor has no such field until a v30 bump.
 */
async function renderDescriptor(descriptor: RuntimeServiceDescriptor, context: AdminCommandContext, root: string, options: ConfigLoadOptions, locale: Locale): Promise<string> {
  const own = readBuildIdentity(), build = descriptor.build;
  const commit = build ? build.sourceCommit?.slice(0, 12) ?? build.sourceTreeSha256.slice(0, 12) : '', ownCommit = own?.sourceCommit?.slice(0, 12) ?? own?.sourceTreeSha256.slice(0, 12) ?? '-';
  const buildText = !build ? t('cli.runtime.status.buildUnknown', {}, locale) : !own ? t('cli.runtime.status.build', { commit }, locale)
    : own.sourceTreeSha256 === build.sourceTreeSha256 ? t('cli.runtime.status.buildSame', { commit }, locale) : t('cli.runtime.status.buildOther', { commit, own: ownCommit }, locale);
  const freshness = await configServiceState(root, options, async () => descriptor);
  const work = await runningWork(context, root, options), paths = context.inspectAdminPaths ? await context.inspectAdminPaths(root, options).catch(() => null) : null;
  const started = descriptor.autoStarted ? t('cli.runtime.status.auto', {}, locale) : t('cli.runtime.status.manual', {}, locale);
  return [t('cli.runtime.status.running', { build: buildText }, locale),
    freshness === 'current' ? t('cli.runtime.status.config.current', {}, locale) : freshness === 'stale' ? t('cli.runtime.status.config.stale', {}, locale) : t('cli.runtime.status.config.unknown', {}, locale),
    work ? t('cli.runtime.status.work', { running: work.running, evaluating: work.evaluating, scope: terminalSafeText(work.scopeId) }, locale) : t('cli.runtime.status.workUnknown', {}, locale),
    ...(paths?.runtimeSocket ? [t('cli.runtime.status.socket', { path: terminalSafeText(paths.runtimeSocket) }, locale)] : []),
    descriptor.shutdownAvailable ? t('cli.runtime.status.service', { service: terminalSafeText(descriptor.identity.serviceId), instance: descriptor.instanceId.slice(0, 8), started }, locale)
      : t('cli.runtime.status.serviceUnconfigured', { instance: descriptor.instanceId.slice(0, 8), started }, locale),
    ...(descriptor.idleStopMs ? [t('cli.runtime.status.idle', { duration: humanDuration(descriptor.idleStopMs, locale) }, locale)] : [])].join('\n');
}
/** A person on a terminal confirms a stop or restart after seeing the work it affects; null work = not readable now (said so). */
async function confirmStop(context: AdminCommandContext, root: string, options: ConfigLoadOptions, locale: Locale, restart: boolean): Promise<boolean> {
  const work = await runningWork(context, root, options);
  return await askAdminCard(context, locale, { title: restart ? t('cli.runtime.card.restartTitle', {}, locale) : t('cli.runtime.card.shutdownTitle', {}, locale), body: [
    work ? t('cli.runtime.card.work', { running: work.running, evaluating: work.evaluating, scope: terminalSafeText(work.scopeId) }, locale) : t('cli.runtime.status.workUnknown', {}, locale),
    t('cli.runtime.card.effect', {}, locale), ...(restart ? [t('cli.runtime.card.restartEffect', {}, locale)] : [])], options: confirmOptions(locale) }) === 'apply';
}

function waitForStop(signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.resolve() : new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}
/** Foreground local host. Normal CLI/MCP calls never start it; only the interactive terminal starts `runtime serve` in the
 * background when no service answers (owner 2026-09-23). */
export async function runtimeCommand(argv: readonly string[], context: AdminCommandContext): Promise<void | ExitCode> {
  const action = argv[1];
  if (!['serve', 'describe', 'shutdown', 'restart', '--help', '-h'].includes(action ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
  let json = false; let language: string | undefined; const shutdown: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const value = argv[i]!;
    if (value === '--json') { if (json) throw ErrorRegistry.createError('CLI_USAGE'); json = true; continue; }
    if (value === '--no-color') continue;
    if (value === '--lang') { language = argv[++i]; if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); continue; }
    const field = { '--service': 'serviceId', '--instance': 'instanceId', '--command-id': 'commandId', '--reason': 'reason' }[value];
    if (action === 'shutdown' && field) {
      const supplied = argv[++i];
      if (!supplied || supplied.startsWith('-') || shutdown[field] !== undefined) throw ErrorRegistry.createError('CLI_USAGE');
      shutdown[field] = supplied; continue;
    }
    throw ErrorRegistry.createError('CLI_USAGE');
  }
  const locale = commandLocale(context, language);
  if (action === '--help' || action === '-h') {
    if (json) throw ErrorRegistry.createError('CLI_USAGE');
    emit(t('cli.help.runtime', {}, locale), adminSinks(context));
    return;
  }
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const output = (value: unknown, render: () => string, level: 'info' | 'error' = 'info') => emit(value, { json, level, ...adminSinks(context), render });
  const interactive = adminInteractive(context, json), cancelled = () => { reportCancelled(context, locale); return EXIT_CODES.error; };
  if (action === 'describe') {
    if (!context.describeRuntimeService || Object.keys(shutdown).length) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
    let descriptor: RuntimeServiceDescriptor;
    try { descriptor = await context.describeRuntimeService(root, options); }
    catch (error) {
      // A stopped service is a successful status read for a person (exit 0). `--json` keeps the typed LOCAL_RUNTIME_UNAVAILABLE document and
      // its exit 1: release tooling reads a failing `describe --json` as "service absent", so that contract is unchanged.
      if (json || (error as { code?: unknown } | null)?.code !== 'LOCAL_RUNTIME_UNAVAILABLE') throw error;
      const paths = context.inspectAdminPaths ? await context.inspectAdminPaths(root, options).catch(() => null) : null;
      emit([t('cli.runtime.status.stopped', {}, locale), ...(paths?.runtimeSocket ? [t('cli.runtime.status.socketAbsent', { path: terminalSafeText(paths.runtimeSocket) }, locale)] : [])].join('\n'), adminSinks(context));
      return;
    }
    const text = json ? '' : await renderDescriptor(descriptor, context, root, options, locale);
    output(descriptor, () => text);
    return;
  }
  if (action === 'restart') {
    // Managed restart: the governed stop (waits for drain and the endpoint's absence), then a start from the current build and configuration.
    if (!context.restartRuntimeService || Object.keys(shutdown).length) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
    if (interactive && !await confirmStop(context, root, options, locale, true)) return cancelled();
    const restarted = await context.restartRuntimeService(root, options);
    output(restarted, () => t('cli.runtime.restarted', { pid: restarted.pid ?? '-', instanceId: restarted.instanceId.slice(0, 8) }, locale));
    return;
  }
  const { reason, ...ids } = shutdown;
  if (action === 'shutdown' && Object.keys(ids).length === 0 && context.stopRuntimeService) {
    // No identity fields: the system builds the governed command from the live descriptor. Owner CLI review 2026-10-19: a person confirms on a
    // card after seeing the running work (the reason is optional there); any other caller names its reason (`--reason`, audited).
    if (!interactive && !reason?.trim()) throw ErrorRegistry.createError('RUNTIME_SHUTDOWN_REASON_REQUIRED');
    if (interactive && !await confirmStop(context, root, options, locale, false)) return cancelled();
    const stopped = await context.stopRuntimeService(root, options, reason?.trim() || t('cli.runtime.reason.terminal', {}, locale));
    output(stopped.result, () => t('cli.runtime.shutdownAdmitted', { serviceId: terminalSafeText(stopped.command.serviceId), instanceId: stopped.command.instanceId.slice(0, 8) }, locale));
    return;
  }
  if (action === 'shutdown') {
    if (!context.shutdownRuntimeService) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
    const command = shutdownCommandSchema.safeParse({ schemaVersion: 1, ...shutdown });
    if (!command.success) throw ErrorRegistry.createError('CLI_USAGE');
    const result = await context.shutdownRuntimeService(root, command.data, options);
    output(result, () => t('cli.runtime.shutdownAdmitted', { serviceId: terminalSafeText(command.data.serviceId), instanceId: command.data.instanceId.slice(0, 8) }, locale));
    return;
  }
  if (!context.startRuntimeService || !context.signal) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
  const host = await context.startRuntimeService(root, {
    onQueryFailure: async event => { output({ schemaVersion: 1, event: 'query-failed', ...event },
      () => `${t('error.QUERY_UNEXPECTED_FAILURE', { errorClass: 'Error', diagnosticId: event.diagnosticId }, locale)}: ${event.detail}`, 'error'); },
    onRunProgression: async (query, result) => {
      if (result.attempted || result.run.tasks.every(task => ['accepted', 'failed', 'cancelled'].includes(task.phase))) {
        output({ schemaVersion: 1, event: 'run-progression', query, result },
          () => t('cli.runtime.runProgression', { runId: query.runId, count: result.attempted }, locale));
      }
    },
    onPreflightProbesSwept: async result => { const failed = result.unlisted || result.unsettled.length > 0 || !!result.held?.length || !!result.settlementFailed?.length;
      output({ schemaVersion: 1, event: 'preflight-probes-swept', result }, () => preflightSweptText(result, locale), failed ? 'error' : 'info'); },
    onRunProgressionError: async (query, error) => {
      output({ schemaVersion: 1, event: 'run-progression-failed', query, code: error.code, params: error.params }, () => runProgressionErrorText(query, error, locale), 'error');
    },
    onReconciliationPage: async (command, result) => {
      const changed = result.outcomes.filter(outcome => outcome.status !== 'skipped');
      if (changed.length) output({ schemaVersion: 1, event: 'reconciliation', command, result },
        () => t('cli.runtime.reconciliation', { count: changed.length }, locale));
    },
    onReconciliationError: async (_command, error) => {
      output({ schemaVersion: 1, event: 'reconciliation-failed', code: error.code },
        () => t('cli.runtime.reconciliationFailed', { code: error.code }, locale), 'error');
    },
    onPage: async (command, result) => { const outcomes = result.outcomes ?? [];
      if (outcomes.length) output({ schemaVersion: 1, event: 'recovery', command, result },
        () => t('cli.runtime.recovery', { count: outcomes.length }, locale)); },
    onError: async (_command, error) => { output({ schemaVersion: 1, event: 'recovery-failed', code: error.code },
      () => t('cli.runtime.recoveryFailed', { code: error.code }, locale), 'error'); },
    onBackup: async event => {
      const trigger = event.trigger === 'daily' ? t('cli.backup.trigger.daily', {}, locale) : t('cli.backup.trigger.before-upgrade', {}, locale);
      output({ schemaVersion: 1, event: 'backup-schedule', ...event },
        () => event.status === 'created' ? t('cli.backup.scheduled', { trigger }, locale)
          : event.status === 'skipped' ? t('cli.backup.scheduleSkipped', { trigger, set: event.set ?? '-', code: event.code ?? '-' }, locale)
          : t('cli.backup.scheduleFailed', { trigger, code: event.code ?? '-' }, locale), event.status === 'created' ? 'info' : 'error'); },
    onIdleShutdown: async event => { output({ schemaVersion: 1, event: 'idle-shutdown', ...event },
      () => t('cli.runtime.idleShutdown', { duration: formatDuration(event.afterMs) }, locale)); },
    onAuditIntegrity: async status => { output({ schemaVersion: 1, event: 'audit-integrity', ...status },
      () => status.status === 'ready' ? t('cli.audit.service', { status: t('cli.audit.service.ready', {}, locale) }, locale)
        : t('cli.audit.service.degradedReason', { status: t('cli.audit.service.degraded', {}, locale), reason: status.reason === 'not-verified' ? t('cli.audit.reason.not-verified', {}, locale)
          : renderAuditReason(status.reason ?? status.verifications.find(value => value.status !== 'match')?.reason ?? 'unavailable', locale) }, locale)); },
    onLedgerUpgraded: async upgrade => { output({ schemaVersion: 1, event: 'ledger-upgraded', ...upgrade },
      () => t('cli.runtime.ledgerUpgraded', { from: upgrade.from, to: upgrade.to, backup: upgrade.backupPath }, locale)); },
    // WORKER-AUTO-REFRESH: the background refresh reports its typed events here; none of them delays or fails readiness.
    onToolchainRefresh: async event => { output({ ...event },
      () => event.phase === 'started' ? t('cli.runtime.toolchainRefreshStarted', {}, locale)
        : event.phase === 'failed' ? t('cli.runtime.toolchainRefreshFailed', { code: event.code ?? 'UNKNOWN' }, locale)
        : event.phase === 'unverified' ? t('cli.runtime.toolchainRefreshUnverified', { code: event.code ?? 'UNKNOWN' }, locale)
        : event.imageId ? t('cli.runtime.toolchainRefreshUpdated', { version: event.imageVersion ?? '-', count: event.appliedProfiles }, locale)
        : t('cli.runtime.toolchainRefreshCurrent', {}, locale), event.phase === 'failed' ? 'error' : 'info'); },
    onToolCallApprovalsExpired: async result => { output({ schemaVersion: 1, event: 'tool-call-approvals-expired', ...result },
      () => result.keyUnavailable ? t('cli.runtime.toolCallApprovalsKeyUnavailable', {}, locale)
        : t('cli.runtime.toolCallApprovalsExpired', { expired: result.expired, failed: result.failed }, locale), result.failed || result.keyUnavailable ? 'error' : 'info'); },
  }, options);
  try {
    output({ schemaVersion: 1, event: 'ready', endpoint: host.endpoint }, () => t('cli.runtime.ready', { endpoint: host.endpoint }, locale));
  } catch (error) { await host.stop(); throw error; }
  // Host completion handlers are attached before any other await so a failing host is never an unhandled rejection.
  const finished = Promise.race([waitForStop(context.signal).then(() => true), host.done.then(() => false)]);
  finished.catch(() => undefined); // marks an early host failure handled; `await finished` below still surfaces it
  // Optional startup currency report (policy data, read-only): advisory only; it never builds, updates or affects readiness.
  try {
    const startupPolicy = (await loadConfig(root, options)).toolchains.update;
    if (startupPolicy.atStartup && startupPolicy.mode !== 'auto' && context.inspectToolchainCurrency) { // `auto` refreshes in the service itself
      try { const report = await context.inspectToolchainCurrency(root, options); output({ schemaVersion: 1, event: 'toolchains', report },
        () => t('cli.runtime.toolchains', { count: report.providers.filter(entry => entry.status === 'stale').length }, locale)); }
      catch (error) { output({ schemaVersion: 1, event: 'toolchains-failed', code: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'UNKNOWN' },
        () => t('cli.runtime.toolchainsFailed', {}, locale)); }
    }
  } catch { /* Configuration unavailable to the startup report: silent, the service itself already reported readiness. */ }
  const stoppedBySignal = await finished;
  if (!stoppedBySignal) return;
  const result = await host.stop();
  output({ schemaVersion: 1, event: 'stopped', ...result }, () => t('cli.runtime.stopped', { state: result.state === 'clean' ? t('cli.runtime.clean', {}, locale) : t('cli.runtime.incomplete', {}, locale) }, locale), result.state === 'clean' ? 'info' : 'error');
  if (result.state === 'incomplete') throw ErrorRegistry.createError('RUNTIME_SERVICE_SHUTDOWN_INCOMPLETE');
  await host.done;
}
