import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { ConfigLoadOptions } from '#platform/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { authenticate, RunPolicyAuthorization, RunProgressionTurn, runQuerySchema, RunStoreError, type RunQuery } from '#engine/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { evaluateConfiguredTask, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Shared runtime composition for automatic progression; not a separate public command.
 * Every operation reloads local scope/policy; a previous turn or reservation is not a new permission.
 */
export async function advanceConfiguredRun(projectRoot: string, input: RunQuery, signal: AbortSignal,
  options: ConfigLoadOptions = {}, admitExecution: (work: () => Promise<void>) => Promise<void> = work => work(), maxReservations?: number) {
  try {
    const query = runQuerySchema.parse(input);
    const initial = await loadConfiguredScopeContext(projectRoot, query.scopeId, options);
    const turn = new RunProgressionTurn({
      async read(request) {
        const { config, layout, principal, path } = await loadConfiguredScopeContext(projectRoot, request.scopeId, options);
        const verifier = { async verify() { return principal; } };
        const authorization = new RunPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
        await authorization.authorize('inspect', request, await authenticate(verifier, undefined, request.scopeId));
        const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
        try {
          const run = await store.loadRun(request.scopeId, request.runId);
          if (!run) throw new RunStoreError('RUN_STORE_CONFLICT');
          return run;
        } finally { store.close(); }
      },
      async reserve(command) {
        try { await reserveConfiguredRunTasks(projectRoot, command, options); return 'reserved'; }
        catch (error) {
          const failure = queryFailure(error);
          if (failure.code === 'RUN_STORE_CONFLICT') return 'changed';
          if (failure.code === 'RUN_CAPACITY_OR_ORDER' || failure.code === 'RUN_POOL_FULL') return 'waiting';
          throw error;
        }
      },
      async execute(identity) { await admitExecution(async () => { await executeConfiguredTask(projectRoot, identity, options); }); },
      async evaluate(command) {
        try { await evaluateConfiguredTask(projectRoot, command, options); return 'recorded'; }
        catch (error) {
          const failure = queryFailure(error);
          // Only a rejected state fence may be reconsidered from fresh durable evidence.
          if (failure.code === 'RUN_STORE_CONFLICT' || failure.code === 'TASK_EVALUATION_STALE') return 'changed';
          throw error;
        }
      },
      async evaluationRecorded(identity, revision) {
        const { config, principal, layout, path } = await loadConfiguredScopeContext(projectRoot, identity.scopeId, options);
        const authorization = new RunPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
        await authorization.authorize('inspect', query, await authenticate({ async verify() { return principal; } }, undefined, identity.scopeId));
        const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
        try { return await store.hasTaskEvaluation(identity, revision); } finally { store.close(); }
      },
    }, initial.config.service.maxConcurrentExecutions, { commandId: randomUUID }, maxReservations);
    return await turn.advance(query, signal);
  } catch (error) { throw queryFailure(error); }
}
