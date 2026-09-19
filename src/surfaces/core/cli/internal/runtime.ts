import { ErrorRegistry, emit, resolveLocale, t, type ConfigLoadOptions, type ProductLayout } from '#platform/index.js';
import type { CancellationRecoveryCommand, CancellationRecoveryPageResult, RuntimeServiceDrainResult, ReconciliationRecoveryCommand, ReconciliationRecoveryPage } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';

export interface RuntimeServiceHost {
  readonly endpoint: string;
  readonly layout: ProductLayout;
  readonly done: Promise<void>;
  stop(): Promise<RuntimeServiceDrainResult>;
}
export interface RuntimeServiceObserver {
  onReconciliationPage?(command: ReconciliationRecoveryCommand, result: ReconciliationRecoveryPage): void | Promise<void>;
  onReconciliationError?(command: ReconciliationRecoveryCommand, error: { readonly code: string }): void | Promise<void>;
  onPage(command: CancellationRecoveryCommand, result: CancellationRecoveryPageResult): void | Promise<void>;
  onError(command: CancellationRecoveryCommand, error: { readonly code: string }): void | Promise<void>;
}
export type RuntimeServiceStartHandler = (root: string, observer: RuntimeServiceObserver, options: ConfigLoadOptions) => Promise<RuntimeServiceHost>;

function waitForStop(signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.resolve() : new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}
/** Foreground-only local host; this never starts itself during normal CLI/MCP calls. */
export async function runtimeCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1];
  if (action !== 'serve' && action !== '--help' && action !== '-h') throw ErrorRegistry.createError('CLI_USAGE');
  let json = false; let language: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const value = argv[i]!;
    if (value === '--json') { if (json) throw ErrorRegistry.createError('CLI_USAGE'); json = true; continue; }
    if (value === '--no-color') continue;
    if (value === '--lang') { language = argv[++i]; if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); continue; }
    throw ErrorRegistry.createError('CLI_USAGE');
  }
  const locale = resolveLocale(language, context.env); context.onLocale?.(locale);
  if (action !== 'serve') {
    if (json) throw ErrorRegistry.createError('CLI_USAGE');
    emit(t('cli.help.runtime', {}, locale), { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
    return;
  }
  if (!context.startRuntimeService || !context.signal) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const output = (value: unknown, render: () => string, level: 'info' | 'error' = 'info') => emit(value, { json, level,
    ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}), render });
  const host = await context.startRuntimeService(root, {
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
  const stoppedBySignal = await Promise.race([waitForStop(context.signal).then(() => true), host.done.then(() => false)]);
  if (!stoppedBySignal) return;
  const result = await host.stop();
  output({ schemaVersion: 1, event: 'stopped', ...result }, () => t('cli.runtime.stopped', { state: result.state === 'clean' ? t('cli.runtime.clean', {}, locale) : t('cli.runtime.incomplete', {}, locale) }, locale), result.state === 'clean' ? 'info' : 'error');
  if (result.state === 'incomplete') throw ErrorRegistry.createError('RUNTIME_SERVICE_SHUTDOWN_INCOMPLETE');
  await host.done;
}
