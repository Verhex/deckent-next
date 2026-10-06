import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import type { ConfigLoadOptions } from '#platform/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { DockerSupervisor, openSqliteAttemptStore, readWorkerSidecars } from '#adapters/index.js';
import { assessAbandonment, authenticate, DispatchPolicyAuthorization, recordAttemptClosure, RunStoreError, type AbandonmentRefusal } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

export type AbandonedClosure = Readonly<{ identity: AttemptIdentity; status: 'closed'; heartbeat: 'stale' | 'missing' | 'recorded'; phase: string }
  | { identity: AttemptIdentity; status: 'refused'; reason: AbandonmentRefusal; phase: string }>;
/** Operator closure of a launched attempt whose worker is proven gone. Same `reconcile` attempt authority as reconciliation; it never
 * launches, retries, kills or releases anything and never fabricates an exit. Only a granted launch without terminal evidence whose
 * task is active with known effects, whose container the daemon reports absent and whose executor heartbeat is stale (or never written
 * past the stale window) closes as `abandoned` → task `failed`, which releases its pool slot. Unknown effects stay held. */
export async function closeAbandonedConfiguredAttempt(projectRoot: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) {
  try {
    const identity = attemptIdentitySchema.parse(input);
    const { config, layout, principal, path } = await loadConfiguredScopeContext(projectRoot, identity.scopeId, options, 'write');
    const verifier = { async verify() { return principal; } };
    const actor = await authenticate(verifier, undefined, identity.scopeId);
    await new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes)).authorizeIdentity('reconcile', identity, actor);
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
    try {
      const actorRecord = { id: actor.id, issuer: actor.issuer, subject: actor.subject };
      const [run, attempt, dispatch] = await Promise.all([store.loadRun(identity.scopeId, identity.runId), store.load(identity.scopeId, identity.attemptId), store.loadBoundDispatch(identity)]);
      if (!run || !attempt) throw new RunStoreError('RUN_STORE_CONFLICT');
      const phase = () => run.progress.find(task => task.taskId === identity.taskId)?.phase ?? 'pending';
      // Replay: an attempt already recorded as abandoned completes its projection once; a settled one answers without new evidence.
      if (attempt.lastObservation?.result.kind === 'abandoned') {
        await recordAttemptClosure(store, identity, { kind: 'abandoned' }, actorRecord);
        const settled = await store.loadRun(identity.scopeId, identity.runId);
        return Object.freeze({ schemaVersion: 1 as const, layout, closure: Object.freeze({ identity, status: 'closed' as const, heartbeat: 'recorded' as const,
          phase: settled?.progress.find(task => task.taskId === identity.taskId)?.phase ?? 'pending' }) });
      }
      const ledger = { identity, run, attempt, dispatch }, candidate = assessAbandonment(ledger);
      // Only a candidate that passes every ledger condition contacts the daemon or reads the executor sidecar.
      if (candidate.kind === 'refused') return refused(candidate.reason);
      const request = dispatch!.request;
      const activity = await DockerSupervisor.restoreProfile(dispatch!.profile).then(supervisor => supervisor.inspectActivity(request));
      // Same wall clock as the recorded grant time; the sidecar reader applies its own skew bound to the heartbeat age.
      const now = Date.now();
      const heartbeat = await readWorkerSidecars(dirname(request.workspace), 'worker', config.inspection.workers, now, identity)
        .then(files => files.heartbeat, (error: { code?: unknown }) => ({ state: error?.code === 'ENOENT' ? 'missing' : 'unavailable', freshness: 'unknown' as const }));
      const assessment = assessAbandonment(ledger, { container: activity.state, heartbeat, now, staleMs: config.inspection.workers.staleMs });
      if (assessment.kind !== 'abandoned') return refused(assessment.kind === 'refused' ? assessment.reason : 'executor-live');
      await recordAttemptClosure(store, identity, { kind: 'abandoned' }, actorRecord, { container: activity.state, heartbeat: assessment.heartbeat, grantedAt: assessment.grantedAt, observedAt: now });
      const closed = await store.loadRun(identity.scopeId, identity.runId);
      return Object.freeze({ schemaVersion: 1 as const, layout, closure: Object.freeze({ identity, status: 'closed' as const, heartbeat: assessment.heartbeat,
        phase: closed?.progress.find(task => task.taskId === identity.taskId)?.phase ?? 'pending' }) });
      function refused(reason: AbandonmentRefusal) {
        return Object.freeze({ schemaVersion: 1 as const, layout, closure: Object.freeze({ identity, status: 'refused' as const, reason, phase: phase() }) });
      }
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
