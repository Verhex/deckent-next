import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { openSqliteInventoryReader, openSqliteAttemptStore } from '#adapters/index.js';
import { evaluatePolicy, policyResources } from '#domain/index.js';
import { RunAdmissionApplication, runAdmissionSchema, RunPolicyAuthorization, PolicyAuthorizationError, type RunAdmission, type RunCreate } from '#engine/index.js';
import { loadConfiguredRunContext } from './context.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
/** Local OS ingress. Existing pool provisioning is required; no implicit pool creation or config-derived grants. */
export async function createConfiguredRun(projectRoot: string, input: RunAdmission, options: ConfigLoadOptions = {}) {
  try {
    const command = runAdmissionSchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredRunContext(projectRoot, command.scopeId, options);
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
      new RunPolicyAuthorization({ async load() { return document; } }), { async resolve(admitted, actor) {
        const profile = config.admission;
        if (!profile) throw ErrorRegistry.createError('RUN_ADMISSION_NOT_CONFIGURED');
        const decision = evaluatePolicy(document, { principal: actor, action: policyResources.pool.actions[0], scopeId: admitted.scopeId,
          resource: { kind: policyResources.pool.kind, id: profile.poolId } });
        if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
        return { layoutRevision: layout.revision, now: Date.now(), policy: { schemaVersion: 2, poolId: profile.poolId,
          capacity: { executionSlots: profile.executionSlots, inFlightSlots: profile.inFlightSlots }, ordering: admitted.graph.tasks.map(task => task.id) } };
      } });
    return Object.freeze({ schemaVersion: 1 as const, layout, admission: await app.create(command) });
  } catch (error) { throw queryFailure(error); }
}
