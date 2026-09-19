import { ModelInvocationError, modelInvocationQueryInputSchema, type ModelInvocationQuery } from '#domain/index.js';
import { ModelInvocationInspectionApplication, ModelInvocationPolicyAuthorization, type ModelInvocationDelivery } from '#engine/index.js';
import { openSqliteModelInvocationReader, type LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadInvocationContext, loadPeerInvocationContext } from './context.js';

export async function inspectConfiguredModelInvocation(projectRoot: string, input: ModelInvocationQuery, options: ConfigLoadOptions = {}) {
  return inspect(input, scopeId => loadInvocationContext(projectRoot, scopeId, options));
}
/** Internal runtime wiring only; actual socket peer evidence is supplied out of band. */
export async function inspectPeerConfiguredModelInvocation(projectRoot: string, input: ModelInvocationQuery,
  peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, delivery?: ModelInvocationDelivery) {
  return inspect(input, scopeId => loadPeerInvocationContext(projectRoot, scopeId, options, peer), delivery);
}
async function inspect(input: ModelInvocationQuery, loadContext: (scopeId: string) => ReturnType<typeof loadInvocationContext>,
  delivery?: ModelInvocationDelivery) {
  try {
    const parsed = modelInvocationQueryInputSchema.safeParse(input);
    if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
    const query = parsed.data as ModelInvocationQuery;
    const context = await loadContext(query.scopeId);
    return await new ModelInvocationInspectionApplication({ async verify() { return context.principal; } },
      new ModelInvocationPolicyAuthorization(context.policy),
      async () => openSqliteModelInvocationReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs })).inspect(query, undefined, delivery);
  } catch (error) { throw queryFailure(error); }
}
