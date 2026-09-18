import { userInfo } from 'node:os';
import { loadConfig, inspectProductFile, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, readLocalOsIdentity, openSqliteInventoryReader, openSqliteAttemptStore } from '#adapters/index.js';
import { policySchema, policyScopeMembership, evaluatePolicy, policyResources } from '#domain/index.js';
import { RunAdmissionApplication, runAdmissionSchema, RunPolicyAuthorization, PolicyAuthorizationError, type RunAdmission, type RunCreate } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
/** Local OS ingress. Existing pool provisioning is required; no implicit pool creation or config-derived grants. */
export async function createConfiguredRun(projectRoot: string, input: RunAdmission, options: ConfigLoadOptions = {}) {
  try {
    registerProviderConfig(); const command = runAdmissionSchema.parse(input);
    const config = await loadConfig(projectRoot, { ...options, heal: false }); const layout = config.productLayout;
    const identity = readLocalOsIdentity(); let document;
    try { document = policySchema.parse(await createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes).load()); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    const principal = Object.freeze({ ...identity, scopeIds: policyScopeMembership(document, identity, [command.scopeId]) });
    const path = () => inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
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
