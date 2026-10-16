import { observeConfiguredQueueRun } from './queue-view.js';
import { userInfo } from 'node:os';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore, inventoryReadsPerCall } from '#adapters/index.js';
import { DispatchPolicyAuthorization, RunInspectionApplication, runQuerySchema, RunPolicyAuthorization, type RunQuery } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { observeConfiguredRunResults } from './result-view.js';
import { configuredWorkCostEvidence } from '#composition/core/resource-observation/index.js';
export async function inspectConfiguredRun(projectRoot: string, input: RunQuery, options: ConfigLoadOptions = {}) {
  try {
    const query = runQuerySchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, query.scopeId, options, 'read');
    const store = inventoryReadsPerCall(path, { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
    const app = new RunInspectionApplication(store, { async verify() { return principal; } }, new RunPolicyAuthorization({ async load() { return document; } }), { store,
      artifacts: FileArtifactStore.reader(() => inspectProductDirectory(layout, 'artifacts'), config.artifacts.maxBytes), authorization: new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes)) }, { ...(config.admission ? { admission: { poolId: config.admission.poolId, executionSlots: config.admission.executionSlots, inFlightSlots: config.admission.inFlightSlots } } : {}), ceiling: typeof config.max_workers === 'number' ? config.max_workers : Infinity }, configuredWorkCostEvidence(config, layout,
      { readDispatch: store.loadBoundDispatch, readMetrics: store.loadRunMetrics, loadWorkerEventLog: store.loadWorkerEventLog }));
    const inspected = await app.inspectWithModels(query);
    if (!inspected.run) return Object.freeze({ schemaVersion: 1 as const, layout, ...inspected });
    let run = await observeConfiguredRunResults(config, options.env, inspected.run, principal,
      new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes)));
    const targetQueue = await observeConfiguredQueueRun(query, config, path, principal, new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes)));
    if (targetQueue.records.length || targetQueue.truncated) run = { ...run, targetQueue };
    return Object.freeze({ schemaVersion: 1 as const, layout, ...inspected, run });
  } catch (error) { throw queryFailure(error); }
}
