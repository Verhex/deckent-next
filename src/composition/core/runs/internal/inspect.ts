import { userInfo } from 'node:os';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { readMonitorRunResults, FileArtifactStore, inventoryReadsPerCall } from '#adapters/index.js';
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
      artifacts: FileArtifactStore.reader(() => inspectProductDirectory(layout, 'artifacts'), config.artifacts.maxBytes), authorization: new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes)) }, { ...(config.admission ? { admission: { poolId: config.admission.poolId, executionSlots: config.admission.executionSlots, inFlightSlots: config.admission.inFlightSlots } } : {}), ceiling: typeof config.max_workers === 'number' ? config.max_workers : Infinity });
    const inspected = await app.inspectWithModels(query);
    if (!inspected.run) return Object.freeze({ schemaVersion: 1 as const, layout, ...inspected });
    const briefs = await readMonitorRunResults(config, options.env, query, inspected.run, async identity => {
      try { await new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes)).authorizeIdentity('read-output', identity, principal); return true; }
      catch (error) { if (['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED', 'APPROVAL_DENIED'].includes(queryFailure(error).code)) return false; throw error; }
    });
    return Object.freeze({ schemaVersion: 1 as const, layout, ...inspected, run: { ...inspected.run,
      tasks: inspected.run.tasks.map(task => ({ ...task, ...(briefs.has(task.id) ? { resultBrief: briefs.get(task.id)! } : {}) })) } });
  } catch (error) { throw queryFailure(error); }
}
