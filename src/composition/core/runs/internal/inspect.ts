import { userInfo } from 'node:os';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore, openSqliteInventoryReader } from '#adapters/index.js';
import { describeRunWorkerModels, DispatchPolicyAuthorization, RunInspectionApplication, runQuerySchema, RunPolicyAuthorization, type RunQuery } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
/** Local CLI/SDK scope authority comes from trusted policy, never request/config membership. */
export async function inspectConfiguredRun(projectRoot: string, input: RunQuery, options: ConfigLoadOptions = {}) {
  let reader: Awaited<ReturnType<typeof openSqliteInventoryReader>> | undefined;
  try {
    const query = runQuerySchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, query.scopeId, options, 'read');
    let snapshot: import('#domain/index.js').RunSnapshot | null = null;
    const store = { async loadRun(scopeId: string, runId: string) {
      reader ??= await openSqliteInventoryReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
      return snapshot = await reader.loadRun(scopeId, runId);
    } };
    const run = await new RunInspectionApplication(store, { async verify() { return principal; } }, new RunPolicyAuthorization({ async load() { return document; } })).inspect(query);
    // WORKER-CURRENCY-2: requested → init → usage → verdict of pinned worker tasks; sealed evidence needs `read-output` on each attempt.
    const models = run && snapshot && reader ? await describeRunWorkerModels(snapshot, principal, reader, { read: async (...args) => new FileArtifactStore({ root: await inspectProductDirectory(layout,
      'artifacts'), maxBytes: config.artifacts.maxBytes }).read(...args) }, new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes))) : [];
    return Object.freeze({ schemaVersion: 1 as const, layout, run, models });
  } catch (error) { throw queryFailure(error); } finally { reader?.close(); }
}
