import { ModelInvocationError, modelInvocationCancellationCommandInputSchema, type ModelInvocationCancellationCommand } from '#domain/index.js';
import { ModelInvocationCancellationApplication, ModelInvocationPolicyAuthorization, type ModelInvocationControllers,
  type ModelInvocationDelivery } from '#engine/index.js';
import { openSqliteModelInvocationStore, type LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadPeerInvocationContext } from './context.js';

/** Shared runtime mutation only. Client input never supplies principal or a live controller. */
export async function cancelPeerConfiguredModelInvocation(projectRoot: string, input: ModelInvocationCancellationCommand,
  peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, delivery?: ModelInvocationDelivery, controllers?: ModelInvocationControllers) {
  try {
    const parsed = modelInvocationCancellationCommandInputSchema.safeParse(input);
    if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
    const command = parsed.data;
    const context = await loadPeerInvocationContext(projectRoot, command.scopeId, options, peer);
    return await new ModelInvocationCancellationApplication({ async verify() { return context.principal; } },
      new ModelInvocationPolicyAuthorization(context.policy),
      async () => openSqliteModelInvocationStore(await context.path(), context.config.storage.sqlite, 'forbid'),
      { now: Date.now }, controllers).cancel(command, undefined, delivery);
  } catch (error) { throw queryFailure(error); }
}
