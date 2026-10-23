import { abortableRuntimeWait } from './wait.js';
import { SystemTrustedClock, ErrorRegistry, loadConfig, type ConfigLoadOptions, type DeckentError } from '#platform/index.js';
import { ReconciliationRuntimeLoop, type ReconciliationRecoveryCommand, type ReconciliationRecoveryPage } from '#engine/index.js';
import { prepareConfiguredNervous, prepareConfiguredRecovery, recoverConfiguredReconciliation } from '#composition/core/runs/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { prepareConfiguredMemoryEvaluation, prepareConfiguredMemoryExtraction, replayConfiguredMemoryPurges } from '#composition/core/memory/index.js';

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
  // S4B-4 §6.6: every memory purge the journal holds is re-applied before this service admits work (a restore never un-purges); held on failure.
  await replayConfiguredMemoryPurges(projectRoot, options);
  if (!runtime.scopeIds.length) {
    const run: (signal: AbortSignal) => Promise<void> = async () => {};
    return Object.freeze({ run });
  }
  const clock = new SystemTrustedClock();
  // S6R-2/3: Nervous reads each page after reconciliation (shadow seals, live may act); its failure is reported, never a reconciliation failure.
  const nervous = prepareConfiguredNervous(projectRoot, options, config.runRuntime.nervous.mode, runtime.pageSize);
  // S6R-5: the recovery decision after Nervous, once per scope pass (first page); its failure is reported, never a reconciliation failure.
  const recovery = prepareConfiguredRecovery(projectRoot, options, config.runRuntime.recovery.mode);
  // S4B-1: the memory distiller takes one bounded page per scope pass (first page only), off the hot path; its failure is reported, never a reconciliation failure.
  const memory = prepareConfiguredMemoryExtraction(projectRoot, options, config.memoryAutomation.extraction.mode);
  // S4B-3: the memory evaluator after the distiller, at most once per pass interval per scope; its failure is reported, never a reconciliation failure.
  const evaluation = prepareConfiguredMemoryEvaluation(projectRoot, options, config.memoryAutomation.verification.mode);
  const loop = new ReconciliationRuntimeLoop(async command =>
    (await recoverConfiguredReconciliation(projectRoot, command, options, serviceScopeIds)).recovery,
  abortableRuntimeWait, { now: () => clock.sample().monotonicMs }, {
    async onPage(command, result) { await observer.onPage(command, result); await nervous?.observe(command).catch(error => observer.onError(command, queryFailure(error)));
      if (command.after === null) { await recovery?.run(command.scopeId).catch(error => observer.onError(command, queryFailure(error)));
        await memory?.run(command.scopeId).catch(error => observer.onError(command, queryFailure(error)));
        await evaluation?.run(command.scopeId).catch(error => observer.onError(command, queryFailure(error))); } },
    async onError(command, error) { await observer.onError(command, queryFailure(error)); },
  }, { scopeIds: runtime.scopeIds, pollIntervalMs: runtime.pollIntervalMs, failureBackoffMs: runtime.failureBackoffMs });
  return Object.freeze({ run: (signal: AbortSignal) => loop.run(signal) });
}
