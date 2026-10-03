import { createHash } from 'node:crypto';
import { applyAttemptObservation, sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import type { AttemptStore } from '#engine/core/attempts/index.js';
import { AttemptStoreError } from '#engine/core/attempts/index.js';
import type { RunStore } from '#engine/core/runs/index.js';
import { HandoffError } from '#engine/core/handoff-observation/index.js';
/** Engine-owned typed pre-start failure; no worker exit or acceptance evidence is fabricated. Replay completes interrupted projection. */
export async function recordHandoffRefusal(store: AttemptStore & Pick<RunStore, 'loadRun' | 'projectRunAttempt'>,
  identity: AttemptIdentity, error: HandoffError, actor: { id: string; issuer: string; subject: string }) {
  const snapshot = await store.load(identity.scopeId, identity.attemptId);
  if (!snapshot || !sameAttemptIdentity(snapshot.identity, identity)) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
  const commandId = 'handoff-refused-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  if (!snapshot.lastObservation) {
    const observation = { protocolVersion: 1 as const, identity, sequence: 1, eventId: commandId, result: { kind: 'handoff-refused' as const, code: error.code } };
    const next = applyAttemptObservation(snapshot, observation, snapshot.revision);
    await store.commit({ commandId, command: JSON.stringify(observation), snapshot: next, expectedRevision: snapshot.revision });
  } else if (snapshot.lastObservation.result.kind !== 'handoff-refused' || snapshot.lastObservation.result.code !== error.code) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
  const run = await store.loadRun(identity.scopeId, identity.runId);
  if (!run) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
  const binding = run.bindings.find(value => sameAttemptIdentity(value.identity, identity));
  if (binding?.observedKind !== 'handoff-refused') await store.projectRunAttempt({ commandId: commandId + '-project', actor, scopeId: identity.scopeId,
    runId: identity.runId, attemptId: identity.attemptId, expectedRevision: run.revision });
}
