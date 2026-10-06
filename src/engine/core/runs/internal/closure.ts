import { createHash } from 'node:crypto';
import { applyAttemptObservation, sameAttemptIdentity, type AttemptIdentity, type AttemptObservation, type AttemptSnapshot, type RunSnapshot } from '#domain/index.js';
import { AttemptStoreError, type AttemptStore } from '#engine/core/attempts/index.js';
import type { DispatchRecord } from '#engine/core/dispatch/index.js';
import type { WorkerSidecars } from '#engine/core/worker-observation/index.js';
import { RunStoreError, type RunStore } from './store.js';

type ClosingResult = Extract<AttemptObservation['result'], { kind: 'handoff-refused' | 'launch-refused' | 'abandoned' }>;
type Actor = Readonly<{ id: string; issuer: string; subject: string }>;
/** The one recorder of attempt evidence that fails a task without a process exit (typed pre-launch refusal or proven abandonment).
 * The observation and the Run projection are separate receipts; a replay completes an interrupted projection and never rewrites history.
 * `audit`, when given, is kept verbatim in the attempt receipt next to the observation and the acting principal. */
export async function recordAttemptClosure(store: AttemptStore & Pick<RunStore, 'loadRun' | 'projectRunAttempt'>,
  identity: AttemptIdentity, result: ClosingResult, actor: Actor, audit?: unknown) {
  const snapshot = await store.load(identity.scopeId, identity.attemptId);
  if (!snapshot || !sameAttemptIdentity(snapshot.identity, identity)) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
  const commandId = result.kind + '-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const recorded = snapshot.lastObservation?.result;
  if (!recorded || (result.kind === 'abandoned' && recorded.kind === 'started')) {
    const observation = { protocolVersion: 1 as const, identity, sequence: (snapshot.lastObservation?.sequence ?? 0) + 1, eventId: commandId, result };
    const next = applyAttemptObservation(snapshot, observation, snapshot.revision);
    const command = JSON.stringify(audit === undefined ? observation : { observation, actor, audit });
    await store.commit({ commandId, command, snapshot: next, expectedRevision: snapshot.revision });
  } else if (JSON.stringify(recorded) !== JSON.stringify(result)) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
  const run = await store.loadRun(identity.scopeId, identity.runId);
  if (!run) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
  const binding = run.bindings.find(value => sameAttemptIdentity(value.identity, identity));
  if (binding?.observedKind !== result.kind) await store.projectRunAttempt({ commandId: commandId + '-project', actor, scopeId: identity.scopeId,
    runId: identity.runId, attemptId: identity.attemptId, expectedRevision: run.revision });
}

/** Refusal codes that recur deterministically for the same pinned attempt before any dispatch claim: retrying them each turn cannot
 * succeed, so the attempt closes as `launch-refused`. Every other code (store contention, policy, credentials, daemon, workspace
 * locks, unclassified adapter errors) stays transient: the turn fails as before and the runtime's failure backoff applies. */
const PERMANENT_LAUNCH_REFUSALS: ReadonlySet<string> = new Set(['EXECUTION_NOT_CONFIGURED', 'EXECUTION_HOST_UNSUPPORTED', 'EXECUTION_PROFILE_INVALID', 'DISPATCH_ARTIFACT_REQUIRED']);
export function classifyLaunchRefusal(error: unknown): Readonly<{ disposition: 'permanent'; code: string }> | Readonly<{ disposition: 'transient' }> {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
  return code !== null && PERMANENT_LAUNCH_REFUSALS.has(code) ? Object.freeze({ disposition: 'permanent' as const, code }) : Object.freeze({ disposition: 'transient' as const });
}

/** Ledger state of one attempt; `dispatch` is its exact bound dispatch record. */
export interface AbandonmentLedger { readonly identity: AttemptIdentity; readonly run: RunSnapshot; readonly attempt: AttemptSnapshot; readonly dispatch: DispatchRecord | null }
/** Live evidence, gathered only for a ledger candidate. `container` is the supervisor's read-only activity state (`missing` only on the
 * daemon's explicit absent response); `heartbeat` is the executor sidecar read bound to this attempt. */
export interface AbandonmentLive {
  readonly container: string;
  readonly heartbeat: Pick<WorkerSidecars['heartbeat'], 'state' | 'freshness'>;
  readonly now: number;
  readonly staleMs: number;
}
export type AbandonmentRefusal = 'not-launched' | 'terminal' | 'not-active' | 'effects-unresolved' | 'container-present' | 'executor-live';
export type AbandonmentAssessment = Readonly<{ kind: 'candidate' }> | Readonly<{ kind: 'abandoned'; heartbeat: 'stale' | 'missing'; grantedAt: number }>
  | Readonly<{ kind: 'refused'; reason: AbandonmentRefusal }>;
/** Pure abandonment decision. A launch is abandoned only when it was granted, has no terminal evidence, its task is still active
 * with known effects (no unknown/cancelled observation), the container is proven absent and the executor is proven inactive:
 * a stale heartbeat, or no heartbeat at all once the grant is older than the stale window. Anything else stays with its owner.
 * Without live evidence the result is only whether the ledger makes the attempt a candidate worth observing. */
export function assessAbandonment(ledger: AbandonmentLedger, live?: AbandonmentLive): AbandonmentAssessment {
  const refused = (reason: AbandonmentRefusal) => Object.freeze({ kind: 'refused' as const, reason });
  const { run, attempt, dispatch, identity } = ledger;
  if (!sameAttemptIdentity(attempt.identity, identity)) throw new RunStoreError('RUN_STORE_CONFLICT');
  const binding = run.bindings.find(value => sameAttemptIdentity(value.identity, identity));
  const task = run.progress.find(value => value.taskId === identity.taskId);
  if (!binding || !task) return refused('not-active');
  if (task.unresolvedEffects || ['unknown', 'cancelled'].includes(binding.observedKind ?? '') || ['unknown', 'cancelled'].includes(attempt.lastObservation?.result.kind ?? '')) return refused('effects-unresolved');
  if (task.phase !== 'active' || !(binding.observedKind === null || binding.observedKind === 'started')) return refused('not-active');
  if (!dispatch || dispatch.launch !== 'granted' || !dispatch.grant || !sameAttemptIdentity(dispatch.request.identity, identity)) return refused('not-launched');
  if (dispatch.terminal) return refused('terminal');
  if (!live) return Object.freeze({ kind: 'candidate' });
  if (live.container !== 'missing') return refused('container-present');
  if (live.heartbeat.state === 'available' && live.heartbeat.freshness === 'stale') return Object.freeze({ kind: 'abandoned', heartbeat: 'stale', grantedAt: dispatch.grant.grantedAt });
  if (live.heartbeat.state === 'missing' && live.now - dispatch.grant.grantedAt > live.staleMs) return Object.freeze({ kind: 'abandoned', heartbeat: 'missing', grantedAt: dispatch.grant.grantedAt });
  return refused('executor-live');
}
