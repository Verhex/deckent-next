import { userInfo } from 'node:os';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore, GIT_QUEUE_DISPLAY, SqliteTargetQueue, inventoryReadsPerCall, openSqliteLedgerReadOnly } from '#adapters/index.js';
import { DispatchPolicyAuthorization, RunInspectionApplication, observeRunQueue, queueObservationReadLimit, runQuerySchema, RunPolicyAuthorization, type DispatchIdentityAuthorization, type RunQuery } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { observeConfiguredRunResults } from './result-view.js';
import { configuredWorkCostEvidence } from '#composition/core/resource-observation/index.js';
type ScopeContext = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
async function observeConfiguredQueueRun(query: RunQuery, config: ScopeContext['config'], path: ScopeContext['path'], principal: ScopeContext['principal'], authorization: DispatchIdentityAuthorization) {
  const db = openSqliteLedgerReadOnly(await path(), config.storage.sqlite), queue = new SqliteTargetQueue(db), limit = config.targetQueue.perTarget;
  try { return await observeRunQueue(queue.forRun(query.scopeId, query.runId, queueObservationReadLimit(limit)), queue, limit, principal, authorization, GIT_QUEUE_DISPLAY); } finally { db.close(); }
}
export async function inspectConfiguredRun(projectRoot: string, input: RunQuery, options: ConfigLoadOptions = {}) {
  try {
    const query = runQuerySchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, query.scopeId, options, 'read');
    const store = inventoryReadsPerCall(path, { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
    const authorization = new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
    const app = new RunInspectionApplication(store, { async verify() { return principal; } }, new RunPolicyAuthorization({ async load() { return document; } }), { store,
      artifacts: FileArtifactStore.reader(() => inspectProductDirectory(layout, 'artifacts'), config.artifacts.maxBytes), authorization }, { ...(config.admission ? { admission: { poolId: config.admission.poolId, executionSlots: config.admission.executionSlots, inFlightSlots: config.admission.inFlightSlots } } : {}), ceiling: typeof config.max_workers === 'number' ? config.max_workers : Infinity }, configuredWorkCostEvidence(config, layout,
      { readDispatch: store.loadBoundDispatch, readMetrics: store.loadRunMetrics, loadWorkerEventLog: store.loadWorkerEventLog }));
    const inspected = await app.inspectWithModels(query);
    if (!inspected.run) return Object.freeze({ schemaVersion: 1 as const, layout, ...inspected });
    let run = await observeConfiguredRunResults(config, options.env, inspected.run, principal, authorization);
    const targetQueue = await observeConfiguredQueueRun(query, config, path, principal, authorization);
    if (targetQueue.records.length || targetQueue.truncated) run = { ...run, targetQueue };
    return Object.freeze({ schemaVersion: 1 as const, layout, ...inspected, run });
  } catch (error) { throw queryFailure(error); }
}
