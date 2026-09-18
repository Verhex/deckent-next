import { queryFailure } from '#composition/core/query-errors/index.js';
import { type ConfigLoadOptions } from '#platform/index.js';
import { openSqliteInventoryReader } from '#adapters/index.js';
import { RunInspectionApplication, runQuerySchema, RunPolicyAuthorization, type RunQuery } from '#engine/index.js';
import { loadConfiguredRunContext } from './context.js';
/** Local CLI/SDK scope authority comes from trusted policy, never request/config membership. */
export async function inspectConfiguredRun(projectRoot: string, input: RunQuery, options: ConfigLoadOptions = {}) {
  try {
    const query = runQuerySchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredRunContext(projectRoot, query.scopeId, options);
    const store = { async loadRun(scopeId: string, runId: string) {
      const reader = await openSqliteInventoryReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
      try { return await reader.loadRun(scopeId, runId); } finally { reader.close(); }
    } };
    const app = new RunInspectionApplication(store, { async verify() { return principal; } }, new RunPolicyAuthorization({ async load() { return document; } }));
    return Object.freeze({ schemaVersion: 1 as const, layout, run: await app.inspect(query) });
  } catch (error) { throw queryFailure(error); }
}
