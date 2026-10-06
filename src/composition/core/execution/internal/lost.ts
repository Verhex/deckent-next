import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import type { ConfigLoadOptions } from '#platform/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { DockerSupervisor, openSqliteAttemptStore, readWorkerSidecars } from '#adapters/index.js';
import { assessWorkerLoss, authenticate, DispatchPolicyAuthorization, recordAttemptClosure, RunStoreError, type WorkerLossRefusal } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Reason code of the operator-observed worker loss; the outcome before the loss is unknown, never a known failure. */
const WORKER_LOST = 'WORKER_LOST';
export type LostAttemptHold = Readonly<{ identity: AttemptIdentity; status: 'held'; heartbeat: 'stale' | 'missing' | 'recorded'; phase: string }
  | { identity: AttemptIdentity; status: 'refused'; reason: WorkerLossRefusal; phase: string }>;
/** Operator marking of a launched attempt whose worker is proven gone. Same `reconcile` attempt authority as reconciliation. A granted
 * launch without exit evidence has an unknown outcome, so this never fails the task, frees its slot, launches, retries, kills,
 * releases or fabricates an exit: it records the typed `unknown` hold (`reconciling`, unresolved effects), which stops progression
 * from restarting the attempt and shows the uncertain effect until a settlement establishes it. A paused executor that later resumes
 * still runs inside the held slot, and its exit evidence cannot clear the hold. */
export async function markLostConfiguredAttempt(projectRoot: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) {
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
      const phaseIn = (value: typeof run | null) => value?.progress.find(task => task.taskId === identity.taskId)?.phase ?? 'pending';
      const held = async (heartbeat: 'stale' | 'missing' | 'recorded') => Object.freeze({ schemaVersion: 1 as const, layout,
        hold: Object.freeze({ identity, status: 'held' as const, heartbeat, phase: phaseIn(await store.loadRun(identity.scopeId, identity.runId)) }) });
      const refused = (reason: WorkerLossRefusal) => Object.freeze({ schemaVersion: 1 as const, layout, hold: Object.freeze({ identity, status: 'refused' as const, reason, phase: phaseIn(run) }) });
      // Replay: an attempt already marked lost completes its projection once and answers without new evidence.
      const last = attempt.lastObservation?.result;
      if (last?.kind === 'unknown' && last.reasonCode === WORKER_LOST) {
        await recordAttemptClosure(store, identity, { kind: 'unknown', reasonCode: WORKER_LOST }, actorRecord);
        return held('recorded');
      }
      const ledger = { identity, run, attempt, dispatch }, candidate = assessWorkerLoss(ledger);
      // Only a candidate that passes every ledger condition contacts the daemon or reads the executor sidecar.
      if (candidate.kind === 'refused' || !dispatch) return refused(candidate.kind === 'refused' ? candidate.reason : 'not-launched');
      const activity = await DockerSupervisor.restoreProfile(dispatch.profile).then(supervisor => supervisor.inspectActivity(dispatch.request));
      // Same wall clock as the recorded grant time; the sidecar reader applies its own skew bound to the heartbeat age.
      const now = Date.now();
      const heartbeat = await readWorkerSidecars(dirname(dispatch.request.workspace), 'worker', config.inspection.workers, now, identity)
        .then(files => files.heartbeat, (error: { code?: unknown }) => ({ state: error?.code === 'ENOENT' ? 'missing' : 'unavailable', freshness: 'unknown' as const }));
      const assessment = assessWorkerLoss(ledger, { container: activity.state, heartbeat, now, staleMs: config.inspection.workers.staleMs });
      if (assessment.kind !== 'lost') return refused(assessment.kind === 'refused' ? assessment.reason : 'executor-live');
      await recordAttemptClosure(store, identity, { kind: 'unknown', reasonCode: WORKER_LOST }, actorRecord,
        { container: activity.state, heartbeat: assessment.heartbeat, grantedAt: assessment.grantedAt, observedAt: now });
      return held(assessment.heartbeat);
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
