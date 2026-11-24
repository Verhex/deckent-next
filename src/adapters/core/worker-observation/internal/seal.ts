import { isDeepStrictEqual } from 'node:util';
import type { AttemptIdentity } from '#domain/index.js';
import type { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
import type { SqliteAttemptStore } from '#adapters/core/attempt-store/index.js';
import { sealWorkerEventLog } from './events.js';

/** EXEC-RELEASE C3: outcome of sealing the worker event log after the gateway closed. Observation only (never the execution outcome), but
 * a failure is typed and returned, never swallowed: the live sidecar stays the only copy and custody release holds as `events-unsealed`. */
export type WorkerEventSealing = Readonly<{ status: 'sealed'; eventCount: number } | { status: 'nothing-to-seal' }
  | { status: 'failed'; code: 'WORKER_EVENTS_SEAL_FAILED'; cause: string | null }>;
type SealInput = Readonly<{ events: Parameters<typeof sealWorkerEventLog>[0]; verification: Parameters<typeof sealWorkerEventLog>[1];
  observation?: Parameters<typeof sealWorkerEventLog>[4]; unconfirmedObservation?: boolean; deadline?: number;
  unreported: number; projectionComplete: boolean | undefined; maxBytes: number }>;
const failed = (cause: string | null): WorkerEventSealing =>
  Object.freeze({ status: 'failed', code: 'WORKER_EVENTS_SEAL_FAILED', cause });
const causeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;

/** Keep the events that fit the artifact limit (the loss stays visible as a byte-cap marker), retain them and record the sealed log. */
export async function sealAttemptWorkerEvents(identity: AttemptIdentity, artifacts: Pick<FileArtifactStore, 'put'> & Partial<Pick<FileArtifactStore, 'read'>>,
  store: Pick<SqliteAttemptStore, 'saveWorkerEventLog'>, input: SealInput): Promise<WorkerEventSealing> {
  const deadline = input.deadline;
  const expired = () => deadline !== undefined && performance.now() >= deadline;
  const seal = async () => {
    if (input.unconfirmedObservation || expired()) return failed(null);
    const lines = sealWorkerEventLog(input.events, input.verification, input.unreported, input.maxBytes, input.observation);
    if (!lines.length) return Object.freeze({ status: 'nothing-to-seal' as const });
    const bytes = Buffer.from(lines.join(''));
    const receipt = await artifacts.put(identity.scopeId, bytes);
    if (expired()) return failed(null);
    if (input.observation && (!artifacts.read || !bytes.equals(await artifacts.read(identity.scopeId, receipt)))) return failed(null);
    if (expired()) return failed(null);
    const expected = { schemaVersion: 1 as const, identity, events: receipt, eventCount: lines.length, sealedAt: Date.now(),
      projection: input.projectionComplete === false ? 'partial' as const : 'complete' as const };
    const stored = await store.saveWorkerEventLog(expected);
    if (expired() || input.observation && !isDeepStrictEqual(stored, expected)) return failed(null);
    return Object.freeze({ status: 'sealed' as const, eventCount: lines.length });
  };
  const pending = seal().catch((error: unknown) => failed(causeOf(error)));
  if (deadline === undefined) return pending;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([pending, new Promise<WorkerEventSealing>(resolve => {
    timer = setTimeout(() => resolve(failed(null)), Math.ceil(Math.max(0, deadline - performance.now())));
  })]).finally(() => clearTimeout(timer));
}
