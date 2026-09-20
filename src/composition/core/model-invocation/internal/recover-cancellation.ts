import { openSqliteModelInvocationCancellationInventory } from '#adapters/index.js';
import { ModelInvocationCancellationRecoveryApplication, ModelInvocationPolicyAuthorization,
  ModelInvocationStoreError, modelInvocationCancellationRecoveryCommandSchema,
  type ModelInvocationControllers } from '#engine/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadInvocationContext } from './context.js';

/** Trusted host recovery: configured scopes and current policy, without provider or secret resolution. */
export async function recoverConfiguredModelCancellations(projectRoot: string, input: unknown,
  controllers: ModelInvocationControllers, expectedLayoutIdentity: string, options: ConfigLoadOptions = {}) {
  try {
    const command = modelInvocationCancellationRecoveryCommandSchema.parse(input);
    const context = await loadInvocationContext(projectRoot, command.scopeId, options);
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
