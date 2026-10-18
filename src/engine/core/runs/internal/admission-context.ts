import { ErrorRegistry, type CoreConfig } from '#platform/index.js';
import { admitWorkerModels, type ModelCatalogReader, type WorkerAdmissionWarning } from '#engine/core/model-activation/index.js';
import { resolveWorkerEffortExecution, type WorkerEffortCompiler } from './worker-effort.js';
import type { ExecutionRegistryValidation } from './registry.js';
import { assertTaskGraphLimits } from './resource-ceilings.js';
import type { RunAdmissionApplication, RunAdmissionContext } from './admission.js';
type Store = ConstructorParameters<typeof RunAdmissionApplication>[0];
/** Per-call store lifetimes keep native connections in their adapters and avoid holding a writer across admission preparation. */
export function runAdmissionStorePerCall(ports: { reader(): Promise<Pick<Store, 'loadRunReceipt'> & { close(): void }>;
  writer(): Promise<Pick<Store, 'createRun' | 'loadRunWorkspaceCustody'> & { close(): void }> }): Store {
  return {
    async loadRunReceipt(scopeId, commandId) { const store = await ports.reader(); try { return await store.loadRunReceipt(scopeId, commandId); } finally { store.close(); } },
    async loadRunWorkspaceCustody(scopeId, runId) { const store = await ports.writer(); try { return await store.loadRunWorkspaceCustody(scopeId, runId); } finally { store.close(); } },
    async createRun(request, workspace, authority) { const store = await ports.writer(); try { return await store.createRun(request, workspace, authority); } finally { store.close(); } },
  };
}
/** The same application-owned admission preparation is used for public Runs and private-candidate verification Runs. */
export function createRunAdmissionContext(config: Pick<CoreConfig, 'admission' | 'max_workers'> & { runRuntime?: Pick<CoreConfig['runRuntime'], 'stallRecovery'> }, layoutRevision: string, ports: {
  catalog(): Promise<ModelCatalogReader & { close(): void }>; validation: ExecutionRegistryValidation; compiler: WorkerEffortCompiler;
  refreshing(): Promise<boolean>; warnings(value: readonly WorkerAdmissionWarning[]): void; now(): number;
  /** R3: the deadline a watchable profile's silence policy must stop before; absent or null freezes no policy. */
  silenceDeadline?(profile: Parameters<ExecutionRegistryValidation['profile']>[0]): number | null;
}): RunAdmissionContext {
  return { async resolve(admitted) {
    const profile = config.admission;
    if (!profile) throw ErrorRegistry.createError('RUN_ADMISSION_NOT_CONFIGURED');
    assertTaskGraphLimits(admitted.graph, profile.graph);
    const catalog = await ports.catalog(); let execution;
    try {
      const stall = config.runRuntime?.stallRecovery, deadline = ports.silenceDeadline;
      const validation = stall && deadline ? { ...ports.validation, silence: { policy: { warnAfterMs: stall.warnAfterMs, stopAfterMs: stall.stopAfterMs, maxRetries: stall.maxRetries }, deadline } } : ports.validation;
      execution = await resolveWorkerEffortExecution(admitted.graph, profile.registry, catalog, validation, ports.compiler);
      ports.warnings(await admitWorkerModels(execution.tasks, admitted.scopeId, catalog, ports.now(), admitted.graph.tasks, { imageRefreshInProgress: await ports.refreshing() }));
    } finally { catalog.close(); }
    return { execution, layoutRevision, now: ports.now(), policy: { schemaVersion: 2, poolId: profile.poolId,
      capacity: { executionSlots: Math.min(profile.executionSlots, typeof config.max_workers === 'number' ? config.max_workers : Infinity),
        inFlightSlots: Math.min(profile.inFlightSlots, typeof config.max_workers === 'number' ? config.max_workers : Infinity) }, ordering: admitted.graph.tasks.map(task => task.id) } };
  } };
}
