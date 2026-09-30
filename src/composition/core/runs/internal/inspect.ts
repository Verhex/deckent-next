import { userInfo } from 'node:os';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore, inventoryReadsPerCall } from '#adapters/index.js';
import { DispatchPolicyAuthorization, RunInspectionApplication, runQuerySchema, RunPolicyAuthorization, type RunQuery } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
/** Local CLI/SDK scope authority comes from trusted policy, never request/config membership; model rows need `read-output` per attempt. */
export async function inspectConfiguredRun(projectRoot: string, input: RunQuery, options: ConfigLoadOptions = {}) {
  try {
    const query = runQuerySchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, query.scopeId, options, 'read');
    const store = inventoryReadsPerCall(path, { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
    const app = new RunInspectionApplication(store, { async verify() { return principal; } }, new RunPolicyAuthorization({ async load() { return document; } }), { store,
      artifacts: FileArtifactStore.reader(() => inspectProductDirectory(layout, 'artifacts'), config.artifacts.maxBytes), authorization: new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes)) });
    return Object.freeze({ schemaVersion: 1 as const, layout, ...await app.inspectWithModels(query) });
  } catch (error) { throw queryFailure(error); }
}
