import type { AttemptIdentity } from '#domain/index.js';
import type { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
import type { SqliteAttemptStore } from '#adapters/core/attempt-store/index.js';
import { sealWorkerEventLog } from './events.js';

/** EXEC-RELEASE C3: outcome of sealing the worker event log after the gateway closed. Observation only (never the execution outcome), but
 * a failure is typed and returned, never swallowed: the live sidecar stays the only copy and custody release holds as `events-unsealed`. */
export type WorkerEventSealing = Readonly<{ status: 'sealed'; eventCount: number } | { status: 'nothing-to-seal' }
  | { status: 'failed'; code: 'WORKER_EVENTS_SEAL_FAILED'; cause: string | null }>;
type SealInput = Readonly<{ events: Parameters<typeof sealWorkerEventLog>[0]; verification: Parameters<typeof sealWorkerEventLog>[1];
  unreported: number; projectionComplete: boolean | undefined; maxBytes: number }>;
const causeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;

/** Keep the events that fit the artifact limit (the loss stays visible as a byte-cap marker), retain them and record the sealed log. */
export async function sealAttemptWorkerEvents(identity: AttemptIdentity, artifacts: Pick<FileArtifactStore, 'put'>,
  store: Pick<SqliteAttemptStore, 'saveWorkerEventLog'>, input: SealInput): Promise<WorkerEventSealing> {
  try {
    const lines = sealWorkerEventLog(input.events, input.verification, input.unreported, input.maxBytes);
    if (!lines.length) return Object.freeze({ status: 'nothing-to-seal' });
    const receipt = await artifacts.put(identity.scopeId, Buffer.from(lines.join('')));
    await store.saveWorkerEventLog({ schemaVersion: 1, identity, events: receipt, eventCount: lines.length, sealedAt: Date.now(),
      projection: input.projectionComplete === false ? 'partial' : 'complete' });
    return Object.freeze({ status: 'sealed', eventCount: lines.length });
  } catch (error) {
    // The live sidecar remains; the failure never changes the execution outcome but is returned typed (never silent).
    return Object.freeze({ status: 'failed', code: 'WORKER_EVENTS_SEAL_FAILED', cause: causeOf(error) });
  }
}
