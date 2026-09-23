import { ErrorRegistry, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions, type ProductLayout } from '#platform/index.js';
import { shutdownCommandSchema, type CancellationRecoveryCommand, type CancellationRecoveryPageResult, type RuntimeServiceDescriptor,
  type RuntimeServiceDrainResult, type RunView, type ProgressionCursor, type ReconciliationRecoveryCommand, type ReconciliationRecoveryPage,
  type ServiceShutdownAdmissionResult, type ShutdownCommand } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';

export interface RuntimeServiceHost {
  readonly endpoint: string;
  readonly layout: ProductLayout;
  readonly done: Promise<void>;
  stop(): Promise<RuntimeServiceDrainResult>;
}
export interface RuntimeServiceObserver {
  onRunProgression?(query: ProgressionCursor, result: Readonly<{ run: RunView; attempted: number; stopped: boolean }>): void | Promise<void>;
  onRunProgressionError?(query: ProgressionCursor | null, error: { readonly code: string }): void | Promise<void>;
  onReconciliationPage?(command: ReconciliationRecoveryCommand, result: ReconciliationRecoveryPage): void | Promise<void>;
  onReconciliationError?(command: ReconciliationRecoveryCommand, error: { readonly code: string }): void | Promise<void>;
  onPage(command: CancellationRecoveryCommand, result: CancellationRecoveryPageResult): void | Promise<void>;
  onError(command: CancellationRecoveryCommand, error: { readonly code: string }): void | Promise<void>;
}
export type RuntimeServiceStartHandler = (root: string, observer: RuntimeServiceObserver, options: ConfigLoadOptions) => Promise<RuntimeServiceHost>;
export type RuntimeServiceDescribeHandler = (root: string, options: ConfigLoadOptions) => Promise<RuntimeServiceDescriptor>;
export type RuntimeServiceShutdownHandler = (root: string, command: ShutdownCommand, options: ConfigLoadOptions) => Promise<ServiceShutdownAdmissionResult>;

function waitForStop(signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.resolve() : new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}
/** Foreground local host. Normal CLI/MCP calls never start it; only the interactive terminal starts `runtime serve` in the
 * background when no service answers (owner 2026-09-23). */
export async function runtimeCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1];
  if (!['serve', 'describe', 'shutdown', '--help', '-h'].includes(action ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
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
  const locale = resolveLocale(language, context.env); context.onLocale?.(locale);
  if (action === '--help' || action === '-h') {
    if (json) throw ErrorRegistry.createError('CLI_USAGE');
    emit(t('cli.help.runtime', {}, locale), { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
    return;
  }
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const output = (value: unknown, render: () => string, level: 'info' | 'error' = 'info') => emit(value, { json, level,
    ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}), render });
  if (action === 'describe') {
    if (!context.describeRuntimeService || Object.keys(shutdown).length) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
    const descriptor = await context.describeRuntimeService(root, options);
    output(descriptor, () => descriptor.shutdownAvailable
      ? t('cli.runtime.descriptorAvailable', { serviceId: descriptor.identity.serviceId, instanceId: descriptor.instanceId }, locale)
      : t('cli.runtime.descriptorUnavailable', { instanceId: descriptor.instanceId }, locale));
    return;
  }
  if (action === 'shutdown') {
    if (!context.shutdownRuntimeService) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
    const command = shutdownCommandSchema.safeParse({ schemaVersion: 1, ...shutdown });
    if (!command.success) throw ErrorRegistry.createError('CLI_USAGE');
    const result = await context.shutdownRuntimeService(root, command.data, options);
    output(result, () => t('cli.runtime.shutdownAdmitted', { serviceId: command.data.serviceId,
      instanceId: command.data.instanceId, commandId: command.data.commandId }, locale));
    return;
  }
  if (!context.startRuntimeService || !context.signal) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
  const host = await context.startRuntimeService(root, {
    onRunProgression: async (query, result) => {
      if (result.attempted || result.run.tasks.every(task => ['accepted', 'failed', 'cancelled'].includes(task.phase))) {
        output({ schemaVersion: 1, event: 'run-progression', query, result },
          () => t('cli.runtime.runProgression', { runId: query.runId, count: result.attempted }, locale));
      }
    },
    onRunProgressionError: async (_query, error) => {
      output({ schemaVersion: 1, event: 'run-progression-failed', code: error.code },
        () => t('cli.runtime.runProgressionFailed', { code: error.code }, locale), 'error');
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
    if (startupPolicy.atStartup && context.inspectToolchainCurrency) {
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
