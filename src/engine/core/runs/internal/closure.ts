import { createHash } from 'node:crypto';
import { applyAttemptObservation, sameAttemptIdentity, type AttemptIdentity, type AttemptObservation } from '#domain/index.js';
import { AttemptStoreError, type AttemptStore } from '#engine/core/attempts/index.js';
import type { RunStore } from './store.js';

type RecordedResult = Extract<AttemptObservation['result'], { kind: 'handoff-refused' | 'launch-refused' }>;
type Actor = Readonly<{ id: string; issuer: string; subject: string }>;
/** The one recorder of a typed pre-launch refusal (no dispatch claim, no launch, no effect): the attempt finishes and its task fails.
 * The observation and the Run projection are separate receipts; a replay completes an interrupted projection and never rewrites history. */
export async function recordAttemptClosure(store: AttemptStore & Pick<RunStore, 'loadRun' | 'projectRunAttempt'>,
  identity: AttemptIdentity, result: RecordedResult, actor: Actor) {
  const snapshot = await store.load(identity.scopeId, identity.attemptId);
  if (!snapshot || !sameAttemptIdentity(snapshot.identity, identity)) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
  const commandId = result.kind + '-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const recorded = snapshot.lastObservation?.result;
  if (!recorded) {
    const observation = { protocolVersion: 1 as const, identity, sequence: 1, eventId: commandId, result };
    const next = applyAttemptObservation(snapshot, observation, snapshot.revision);
    await store.commit({ commandId, command: JSON.stringify(observation), snapshot: next, expectedRevision: snapshot.revision });
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
