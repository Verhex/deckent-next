import { ModelInvocationError, modelInvocationQueryInputSchema, type ModelInvocationQuery } from '#domain/index.js';
import { ModelInvocationInspectionApplication, ModelInvocationPolicyAuthorization } from '#engine/index.js';
import { openSqliteModelInvocationReader } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadInvocationContext } from './context.js';

export async function inspectConfiguredModelInvocation(projectRoot: string, input: ModelInvocationQuery, options: ConfigLoadOptions = {}) {
  try {
    const parsed = modelInvocationQueryInputSchema.safeParse(input);
    if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
    const query = parsed.data as ModelInvocationQuery;
    const context = await loadInvocationContext(projectRoot, query.scopeId, options);
    return await new ModelInvocationInspectionApplication({ async verify() { return context.principal; } },
      new ModelInvocationPolicyAuthorization(context.policy),
      async () => openSqliteModelInvocationReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs })).inspect(query);
  } catch (error) { throw queryFailure(error); }
}
