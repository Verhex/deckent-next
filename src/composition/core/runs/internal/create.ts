import { validateProcessExitCriterion } from '#capabilities/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { validateDockerTaskProfile, openSqliteInventoryReader, openSqliteAttemptStore } from '#adapters/index.js';
import { resolveExecutionRegistry, RunAdmissionApplication, runAdmissionSchema, RunPolicyAuthorization, PoolPolicyAuthorization, type RunAdmission, type RunCreate } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
/** Local OS ingress. Existing pool provisioning is required; no implicit pool creation or config-derived grants. */
export async function createConfiguredRun(projectRoot: string, input: RunAdmission, options: ConfigLoadOptions = {}) {
  try {
    const command = runAdmissionSchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options);
    const store = {
      async loadRunReceipt(scopeId: string, commandId: string) {
        const reader = await openSqliteInventoryReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
        try { return await reader.loadRunReceipt(scopeId, commandId); } finally { reader.close(); }
      },
      async createRun(request: RunCreate) {
        const writer = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
        try { return await writer.createRun(request); } finally { writer.close(); }
      },
    };
    const app = new RunAdmissionApplication(store, { async verify() { return principal; } },
      new RunPolicyAuthorization({ async load() { return document; } }), new PoolPolicyAuthorization({ async load() { return document; } }), { async resolve(admitted) {
        const profile = config.admission;
        if (!profile) throw ErrorRegistry.createError('RUN_ADMISSION_NOT_CONFIGURED');
        const execution = resolveExecutionRegistry(admitted.graph, profile.registry, {
          profile(value) { try { return validateDockerTaskProfile(value); } catch { throw ErrorRegistry.createError('EXECUTION_PROFILE_INVALID'); } },
          criterion(evaluator, criterion) { try { return validateProcessExitCriterion(evaluator, criterion); } catch { throw ErrorRegistry.createError('TASK_EVALUATOR_INVALID'); } },
        });
        return { execution, layoutRevision: layout.revision, now: Date.now(), policy: { schemaVersion: 2, poolId: profile.poolId,
          capacity: { executionSlots: profile.executionSlots, inFlightSlots: profile.inFlightSlots }, ordering: admitted.graph.tasks.map(task => task.id) } };
      } });
    return Object.freeze({ schemaVersion: 1 as const, layout, admission: await app.create(command) });
  } catch (error) { throw queryFailure(error); }
}
