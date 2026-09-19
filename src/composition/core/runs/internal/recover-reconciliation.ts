import { ErrorRegistry, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { ReconciliationRecoveryApplication, type ReconciliationRecoveryCommand } from '#engine/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { reconcileConfiguredAttempt } from './reconcile.js';
import { recoverConfiguredAttemptOutput } from './recover-output.js';

/** One configured recovery page. Each inventory/effect call performs its own current authorization. */
export async function recoverConfiguredReconciliation(projectRoot: string, input: ReconciliationRecoveryCommand,
  options: ConfigLoadOptions = {}) {
  try {
    const config = await loadConfig(projectRoot, { ...options, heal: false });
    const runtime = config.reconciliationRuntime;
    if (!runtime) throw ErrorRegistry.createError('RECONCILIATION_NOT_CONFIGURED');
    if (runtime.pageSize > config.inspection.maxPageSize) throw ErrorRegistry.createError('RECONCILIATION_RECOVERY_INVALID');
    const application = new ReconciliationRecoveryApplication({
      async inspect(command) {
        if (!runtime.scopeIds.includes(command.scopeId)) throw ErrorRegistry.createError('POLICY_DENIED');
        return (await inspectConfiguredInventory(projectRoot, command, options)).page;
      },
    }, {
      async reconcile(identity) { return (await reconcileConfiguredAttempt(projectRoot, identity, options)).reconciliation; },
      async recoverOutput(identity) { return (await recoverConfiguredAttemptOutput(projectRoot, identity, options)).recovery; },
    }, { maxPageSize: runtime.pageSize, maxConcurrentReconciliations: runtime.maxConcurrentReconciliations });
    return Object.freeze({ schemaVersion: 1 as const, layout: config.productLayout, recovery: await application.recover(input) });
  } catch (error) { throw queryFailure(error); }
}
