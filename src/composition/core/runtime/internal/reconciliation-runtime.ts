import { abortableRuntimeWait } from './wait.js';
import { SystemTrustedClock, ErrorRegistry, loadConfig, type ConfigLoadOptions, type DeckentError } from '#platform/index.js';
import { ReconciliationRuntimeLoop, type ReconciliationRecoveryCommand, type ReconciliationRecoveryPage } from '#engine/index.js';
import { prepareConfiguredNervous, recoverConfiguredReconciliation } from '#composition/core/runs/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

export interface ConfiguredReconciliationRuntimeObserver {
  onPage(command: ReconciliationRecoveryCommand, result: ReconciliationRecoveryPage): void | Promise<void>;
  onError(command: ReconciliationRecoveryCommand, error: DeckentError): void | Promise<void>;
}
/** Preflight before binding a service. Explicit reconciliation scopes win; otherwise the service
 * supplies its installation-owned start-registration scopes, never cancellation scopes. */
export async function prepareConfiguredReconciliationRuntime(projectRoot: string,
  observer: ConfiguredReconciliationRuntimeObserver, options: ConfigLoadOptions = {}, serviceScopeIds?: readonly string[]) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const runtime = config.reconciliationRuntime ?? (serviceScopeIds ? {
    scopeIds: [...serviceScopeIds], pageSize: Math.min(config.runRuntime.pageSize, config.inspection.maxPageSize),
    pollIntervalMs: config.runRuntime.pollIntervalMs, failureBackoffMs: config.runRuntime.failureBackoffMs,
  } : null);
  if (!runtime) throw ErrorRegistry.createError('RECONCILIATION_NOT_CONFIGURED');
  if (runtime.pageSize > config.inspection.maxPageSize) throw ErrorRegistry.createError('RECONCILIATION_RECOVERY_INVALID');
  if (!runtime.scopeIds.length) {
    const run: (signal: AbortSignal) => Promise<void> = async () => {};
    return Object.freeze({ run });
  }
  const clock = new SystemTrustedClock();
  // S6R-2/3: Nervous reads each page after reconciliation (shadow seals, live may act); its failure is reported, never a reconciliation failure.
  const nervous = prepareConfiguredNervous(projectRoot, options, config.runRuntime.nervous.mode, runtime.pageSize);
  const loop = new ReconciliationRuntimeLoop(async command =>
    (await recoverConfiguredReconciliation(projectRoot, command, options, serviceScopeIds)).recovery,
  abortableRuntimeWait, { now: () => clock.sample().monotonicMs }, {
    async onPage(command, result) { await observer.onPage(command, result); await nervous?.observe(command).catch(error => observer.onError(command, queryFailure(error))); },
    async onError(command, error) { await observer.onError(command, queryFailure(error)); },
  }, { scopeIds: runtime.scopeIds, pollIntervalMs: runtime.pollIntervalMs, failureBackoffMs: runtime.failureBackoffMs });
  return Object.freeze({ run: (signal: AbortSignal) => loop.run(signal) });
}
