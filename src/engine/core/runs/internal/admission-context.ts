import { ErrorRegistry, type CoreConfig } from '#platform/index.js';
import { RECOVERY_POLICY_SEED, freezeRecoveryPolicy, loadRecoveryPolicy, type TaskAgentSelection, type TaskGraph } from '#domain/index.js';
import { admitWorkerModels, composeModelRolePolicy, type ModelCatalogReader, type WorkerAdmissionWarning } from '#engine/core/model-activation/index.js';
import { resolveWorkerEffortExecution, type WorkerEffortCompiler } from './worker-effort.js';
import type { ExecutionRegistryValidation } from './registry.js';
import { assertTaskGraphLimits } from './resource-ceilings.js';
import type { RunAdmissionApplication, RunAdmissionContext } from './admission.js';
type Store = ConstructorParameters<typeof RunAdmissionApplication>[0];
/** Per-call store lifetimes keep native connections in their adapters and avoid holding a writer across admission preparation. */
export function runAdmissionStorePerCall(ports: { reader(): Promise<Pick<Store, 'loadRunReceipt'> & { close(): void }>;
  writer(): Promise<Pick<Store, 'createRun' | 'loadRunWorkspaceCustody'> & { close(): void }> }): Store {
  return { async loadRunReceipt(scopeId, commandId) { const store = await ports.reader(); try { return await store.loadRunReceipt(scopeId, commandId); } finally { store.close(); } },
    async loadRunWorkspaceCustody(scopeId, runId) { const store = await ports.writer(); try { return await store.loadRunWorkspaceCustody(scopeId, runId); } finally { store.close(); } },
    async createRun(request, workspace, authority) { const store = await ports.writer(); try { return await store.createRun(request, workspace, authority); } finally { store.close(); } },
  };
}
/** The same application-owned admission preparation is used for public Runs and private-candidate verification Runs. `model_roles`: the installation's tier/role overlays (absent = the Core seed); system worker assignment reads the composed registry (M3). */
export function createRunAdmissionContext(config: Pick<CoreConfig, 'admission' | 'max_workers'> & { runRuntime?: Partial<Pick<CoreConfig['runRuntime'], 'stallRecovery' | 'recovery'>>; readonly model_roles?: unknown }, layoutRevision: string, ports: {
  catalog(): Promise<ModelCatalogReader & { close(): void }>; validation: ExecutionRegistryValidation; compiler: WorkerEffortCompiler; /** S8-1b: the system agent selection (absent: none). */ agents?(graph: TaskGraph, registry: unknown, scopeId: string): Promise<ReadonlyMap<string, TaskAgentSelection>>;
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
      const imageRefreshInProgress = await ports.refreshing(), nowMs = ports.now(), agents = await ports.agents?.(admitted.graph, profile.registry, admitted.scopeId); // re-derived at every admission (N29)
      execution = await resolveWorkerEffortExecution(admitted.graph, profile.registry, catalog, validation, ports.compiler,
        { scopeId: admitted.scopeId, nowMs, imageRefreshInProgress, roles: composeModelRolePolicy(config.model_roles), ...(agents ? { agents } : {}) });
      ports.warnings(await admitWorkerModels(execution.tasks, admitted.scopeId, catalog, nowMs, admitted.graph.tasks, { imageRefreshInProgress }));
      const recovery = config.runRuntime?.recovery?.mode ?? 'off'; if (recovery !== 'off') execution = { ...execution, recovery: freezeRecoveryPolicy(loadRecoveryPolicy(RECOVERY_POLICY_SEED), recovery) }; // S6R-5: registry bounds + protected mode; off freezes none
    } finally { catalog.close(); }
    return { execution, layoutRevision, now: ports.now(), policy: { schemaVersion: 2, poolId: profile.poolId,
      capacity: { executionSlots: Math.min(profile.executionSlots, typeof config.max_workers === 'number' ? config.max_workers : Infinity),
        inFlightSlots: Math.min(profile.inFlightSlots, typeof config.max_workers === 'number' ? config.max_workers : Infinity) }, ordering: admitted.graph.tasks.map(task => task.id) } };
  } };
}
