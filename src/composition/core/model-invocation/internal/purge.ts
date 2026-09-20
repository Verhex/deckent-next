import { ModelInvocationError, modelInvocationPurgeCommandInputSchema, type ModelInvocationPurgeCommand } from '#domain/index.js';
import { ModelInvocationPurgeApplication, ModelInvocationPolicyAuthorization, type ModelInvocationDelivery } from '#engine/index.js';
import { openSqliteModelInvocationStore, type LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadPeerInvocationContext } from './context.js';

/** Runtime-only mutation: authenticated peer evidence is supplied by the local transport. */
export async function purgePeerConfiguredModelInvocationContent(projectRoot: string, input: ModelInvocationPurgeCommand,
  peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, delivery?: ModelInvocationDelivery) {
  try {
    const parsed = modelInvocationPurgeCommandInputSchema.safeParse(input);
    if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
    const command = parsed.data as ModelInvocationPurgeCommand;
    const context = await loadPeerInvocationContext(projectRoot, command.scopeId, options, peer);
    return await new ModelInvocationPurgeApplication({ async verify() { return context.principal; } },
      new ModelInvocationPolicyAuthorization(context.policy),
      async () => openSqliteModelInvocationStore(await context.path(), context.config.storage.sqlite, 'forbid'),
      { now: Date.now }).purge(command, undefined, delivery);
  } catch (error) { throw queryFailure(error); }
}
