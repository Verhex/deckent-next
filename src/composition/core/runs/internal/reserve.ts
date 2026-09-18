import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { ConfigLoadOptions } from '#platform/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { evaluatePolicy, policyResources } from '#domain/index.js';
import { authenticate, PolicyAuthorizationError, RunPolicyAuthorization, RunReservationApplication, runReservationCommandSchema, type RunReservationCommand } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredRunContext } from './context.js';

/** Reserve the next scheduler-selected wave using the persisted Run policy and shared pool. */
export async function reserveConfiguredRunTasks(projectRoot: string, input: RunReservationCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = runReservationCommandSchema.parse(input);
    const { config, layout, principal, path } = await loadConfiguredRunContext(projectRoot, command.scopeId, options);
    const verifier = { async verify() { return principal; } };
    const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
    const authorization = new RunPolicyAuthorization(source);
    await authorization.authorize('reserve', command, await authenticate(verifier, undefined, command.scopeId));
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    try {
      const application = new RunReservationApplication({
        loadRun: store.loadRun.bind(store), loadRunReceipt: store.loadRunReceipt.bind(store),
        loadRunExecutionPolicy: store.loadRunExecutionPolicy.bind(store),
        async reserveRunTasks(request) {
          // A pinned pool selection is not a lasting grant to consume its capacity.
          const policy = await store.loadRunExecutionPolicy(request.scopeId, request.runId);
          let decision;
          try { decision = evaluatePolicy(await source.load(), { principal, action: policyResources.pool.actions[0],
            scopeId: request.scopeId, resource: { kind: policyResources.pool.kind, id: policy.poolId } }); }
          catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
          if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
          return store.reserveRunTasks(request);
        },
      }, verifier, authorization, { now: Date.now, attemptId: randomUUID });
      return Object.freeze({ schemaVersion: 1 as const, layout, reservation: await application.reserve(command) });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
