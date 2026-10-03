import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { ConfigLoadOptions } from '#platform/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { authenticate, reservationRefusalOutcome, RunPolicyAuthorization, RunProgressionTurn, runQuerySchema, RunStoreError, type RunQuery } from '#engine/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { advanceConfiguredRunLifecycle, evaluateConfiguredTask, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
type ConfiguredRunProgressionResult = Awaited<ReturnType<RunProgressionTurn['advance']>> & Readonly<{ waitedForSlotMs?: number }>;
export type RunExecutionAdmission = (work: () => Promise<void>, onSlotWait?: (waitedForSlotMs: number) => void) => Promise<void>;
/** Shared runtime composition for automatic progression; not a separate public command.
 * Every operation reloads local scope/policy; a previous turn or reservation is not a new permission.
 */
export async function advanceConfiguredRun(projectRoot: string, input: RunQuery, signal: AbortSignal,
  options: ConfigLoadOptions = {}, admitExecution: RunExecutionAdmission = work => work(), maxReservations?: number): Promise<ConfiguredRunProgressionResult> {
  try {
    const query = runQuerySchema.parse(input), initial = await loadConfiguredScopeContext(projectRoot, query.scopeId, options, 'write');
    async function withRunStore<T>(request: RunQuery, work: (store: Awaited<ReturnType<typeof openSqliteAttemptStore>>) => Promise<T>) {
      const { config, layout, principal, path } = await loadConfiguredScopeContext(projectRoot, request.scopeId, options, 'write');
      await new RunPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes))
        .authorize('inspect', request, await authenticate({ async verify() { return principal; } }, undefined, request.scopeId));
      const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
      try { return await work(store); } finally { store.close(); }
    }
    let waitedForSlotMs = 0;
    const turn = new RunProgressionTurn({
      async advanceLifecycle(request) { await advanceConfiguredRunLifecycle(projectRoot, request, options); },
      read: request => withRunStore(request, store => store.loadRun(request.scopeId, request.runId).then(run => { if (!run) throw new RunStoreError('RUN_STORE_CONFLICT'); return run; })),
      async reserve(command) {
        try { await reserveConfiguredRunTasks(projectRoot, command, options); return 'reserved'; }
        catch (error) { const outcome = reservationRefusalOutcome(queryFailure(error).code); if (outcome) return outcome; throw error; }
      },
      async execute(identity) { await admitExecution(async () => { if (!signal.aborted) await executeConfiguredTask(projectRoot, identity, options); }, waited => { waitedForSlotMs += waited; }); },
      async evaluate(command) {
        try { await evaluateConfiguredTask(projectRoot, command, options); return 'recorded'; }
        catch (error) {
          const failure = queryFailure(error);
          // Only a rejected state fence may be reconsidered from fresh durable evidence.
          if (failure.code === 'RUN_STORE_CONFLICT' || failure.code === 'TASK_EVALUATION_STALE') return 'changed';
          throw error;
        }
      },
      evaluationRecorded: (identity, revision) => withRunStore(query, store => store.hasTaskEvaluation(identity, revision)),
    }, initial.config.service.maxConcurrentExecutions, { commandId: randomUUID }, maxReservations);
    const result = await turn.advance(query, signal);
    return waitedForSlotMs > 0 ? Object.freeze({ ...result, waitedForSlotMs }) : result;
  } catch (error) { throw queryFailure(error); }
}
