import { abortableRuntimeWait } from './wait.js';
import { ErrorRegistry, loadConfig, type ConfigLoadOptions, type DeckentError } from '#platform/index.js';
import { ReconciliationRuntimeLoop, type ReconciliationRecoveryCommand, type ReconciliationRecoveryPage } from '#engine/index.js';
import { recoverConfiguredReconciliation } from '#composition/core/runs/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

export interface ConfiguredReconciliationRuntimeObserver {
  onPage(command: ReconciliationRecoveryCommand, result: ReconciliationRecoveryPage): void | Promise<void>;
  onError(command: ReconciliationRecoveryCommand, error: DeckentError): void | Promise<void>;
}
/** Preflight before binding a service. Reconciliation scopes never inherit cancellation scopes. */
export async function prepareConfiguredReconciliationRuntime(projectRoot: string,
  observer: ConfiguredReconciliationRuntimeObserver, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const runtime = config.reconciliationRuntime;
  if (!runtime) throw ErrorRegistry.createError('RECONCILIATION_NOT_CONFIGURED');
  if (runtime.pageSize > config.inspection.maxPageSize) throw ErrorRegistry.createError('RECONCILIATION_RECOVERY_INVALID');
  const loop = new ReconciliationRuntimeLoop(async command =>
    (await recoverConfiguredReconciliation(projectRoot, command, options)).recovery,
  abortableRuntimeWait, { now: Date.now }, {
    onPage: observer.onPage,
    async onError(command, error) { await observer.onError(command, queryFailure(error)); },
  }, { scopeIds: runtime.scopeIds, pollIntervalMs: runtime.pollIntervalMs, failureBackoffMs: runtime.failureBackoffMs });
  return Object.freeze({ run: (signal: AbortSignal) => loop.run(signal) });
}
