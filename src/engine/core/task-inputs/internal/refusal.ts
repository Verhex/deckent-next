import type { AttemptIdentity } from '#domain/index.js';
import type { AttemptStore } from '#engine/core/attempts/index.js';
import { recordAttemptClosure, type RunStore } from '#engine/core/runs/index.js';
import { HandoffError } from '#engine/core/handoff-observation/index.js';
/** Engine-owned typed pre-start failure; no worker exit or acceptance evidence is fabricated. Replay completes interrupted projection. */
export async function recordHandoffRefusal(store: AttemptStore & Pick<RunStore, 'loadRun' | 'projectRunAttempt'>,
  identity: AttemptIdentity, error: HandoffError, actor: { id: string; issuer: string; subject: string }) {
  await recordAttemptClosure(store, identity, { kind: 'handoff-refused', code: error.code }, actor);
}
