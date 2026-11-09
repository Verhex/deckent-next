import { isDeepStrictEqual } from 'node:util';
import { inspectConfiguredModelUse } from '#composition/core/model-use/index.js';
import { modelActivationQuerySchema, type ModelActivationQuery } from '#domain/index.js';
import { configuredInvocationProfiles, verifiedPrincipal, ModelActivationInspectionApplication, ModelActivationPolicyAuthorization } from '#engine/index.js';
import { openSqliteModelActivationReader } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** No catalog prerequisite or writable connection: observation cannot create or migrate activation state.
 * `modelUse: false` (connect, KG6 F7): the authorized activation fact before a legacy profile is repaired, never its invocation check. */
export async function inspectConfiguredModelActivation(projectRoot: string, input: ModelActivationQuery, options: ConfigLoadOptions = {}, use: Readonly<{ modelUse?: false }> = {}) {
  try {
    const query = modelActivationQuerySchema.parse(input);
    const { config, document, principal, path } = await loadConfiguredScopeContext(projectRoot, query.scopeId, options, 'read');
    const profile = configuredInvocationProfiles(config).find(item => item.scopeId === query.scopeId && isDeepStrictEqual(item.reference, query.reference));
    if (profile && use.modelUse !== false) await inspectConfiguredModelUse(projectRoot, profile, principal, options);
    const app = new ModelActivationInspectionApplication(verifiedPrincipal(principal),
      new ModelActivationPolicyAuthorization({ async load() { return document; } }),
      async () => openSqliteModelActivationReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs }));
    return await app.inspect(query);
  } catch (error) { throw queryFailure(error); }
}
