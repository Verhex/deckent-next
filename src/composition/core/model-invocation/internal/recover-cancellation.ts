import { openSqliteModelInvocationCancellationInventory, openSqliteModelInvocationStore } from '#adapters/index.js';
import { ModelInvocationCancellationRecoveryApplication, ModelInvocationPolicyAuthorization, isRuntimeServiceModelOwnerId,
  ModelInvocationStoreError, modelInvocationCancellationRecoveryCommandSchema,
  type ModelInvocationControllers } from '#engine/index.js';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadInvocationContext } from './context.js';

/** Trusted host recovery: configured scopes and current policy, without provider or secret resolution. */
export async function recoverConfiguredModelCancellations(projectRoot: string, input: unknown,
  controllers: ModelInvocationControllers, expectedLayoutIdentity: string, options: ConfigLoadOptions = {}) {
  try {
    const command = modelInvocationCancellationRecoveryCommandSchema.parse(input);
    const context = await loadInvocationContext(projectRoot, command.scopeId, options, 'write');
    const config = context.config;
    if (!config.cancellationRuntime?.scopeIds.includes(command.scopeId) || !config.cancellation
      || JSON.stringify(config.productLayout) !== expectedLayoutIdentity) {
      throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
    }
    return await new ModelInvocationCancellationRecoveryApplication({ async verify() { return context.principal; } },
      new ModelInvocationPolicyAuthorization(context.policy),
      async () => openSqliteModelInvocationCancellationInventory(await context.path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs }),
      controllers, { maxPageSize: config.cancellation.recoveryPageSize }).recover(command);
  } catch (error) { throw queryFailure(error); }
}

/** Start reconciliation; the caller must hold endpoint custody (INFLIGHT-FIX, FIX-2143-SLOTS). Holding it proves no service instance of
 * this installation is alive, so an open call a service instance permitted settles `unknown`; slots an earlier build kept for settled
 * `unknown` calls are released. Any other open call, and any allocation whose records do not verify, is never rewritten. */
export async function releaseSettledModelSlots(ledgerPath: string, sqlite: Parameters<typeof openSqliteModelInvocationStore>[1]) {
  const store = await openSqliteModelInvocationStore(ledgerPath, sqlite, 'forbid');
  try { return await store.releaseSettledSlots({ atMs: new SystemTrustedClock().sample().wallMs, endedOwner: isRuntimeServiceModelOwnerId }); }
  finally { store.close(); }
}
