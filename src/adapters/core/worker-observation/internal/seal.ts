import type { AttemptIdentity } from '#domain/index.js';
import type { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
import type { SqliteAttemptStore } from '#adapters/core/attempt-store/index.js';
import { sealWorkerEventLog, type openWorkerEventSink } from './events.js';

/** EXEC-RELEASE C3: outcome of sealing the worker event log after the gateway closed. Observation only (never the execution outcome), but
 * a failure is typed and returned, never swallowed: the live sidecar stays the only copy and custody release holds as `events-unsealed`. */
export type WorkerEventSealing = Readonly<{ status: 'sealed'; eventCount: number } | { status: 'nothing-to-seal' }
  | { status: 'failed'; code: 'WORKER_EVENTS_SEAL_FAILED'; cause: string | null }>;
type SealInput = Readonly<{ events: Parameters<typeof sealWorkerEventLog>[0]; verification: Parameters<typeof sealWorkerEventLog>[1];
  unreported: number; projectionComplete: boolean | undefined; maxBytes: number;
  /** N0: the Attempt's protected observation, whether one is required (offered or held) and the monotonic deadline fencing every stage before the ledger write. */
  observation?: Parameters<typeof sealWorkerEventLog>[4] | undefined; observationRequired?: boolean | undefined; deadline?: number }>;
type Artifacts = Pick<FileArtifactStore, 'put'> & Partial<Pick<FileArtifactStore, 'read'>>;
const causeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
/** Settle `work` or fail at the deadline (no code: `cause: null`). The work is not cancelled; a late artifact stays unreferenced, as no ledger row names it. */
const fenced = <T>(work: Promise<T>, deadline: number | undefined) => deadline === undefined ? work : new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('deadline')), Math.max(0, deadline - performance.now()));
  work.then(resolve, reject).finally(() => clearTimeout(timer));
});

/** Whether the stored bytes read back equal. Any failure of the read (synchronous or not, e.g. ARTIFACT_CORRUPT) or of its fence is `false`, so the
 * caller reports `cause: null`, never a new cause value on this path. */
async function readsBack(artifacts: Artifacts, identity: AttemptIdentity, receipt: Awaited<ReturnType<Artifacts['put']>>, bytes: Buffer, deadline: number | undefined) {
  try { return !!artifacts.read && bytes.equals(await fenced(artifacts.read(identity.scopeId, receipt), deadline)); } catch { return false; }
}

/** Keep the events that fit the artifact limit (the loss stays visible as a byte-cap marker), retain them and record the sealed log. */
export async function sealAttemptWorkerEvents(identity: AttemptIdentity, artifacts: Artifacts,
  store: Pick<SqliteAttemptStore, 'saveWorkerEventLog'>, input: SealInput): Promise<WorkerEventSealing> {
  const expired = () => input.deadline !== undefined && performance.now() >= input.deadline;
  try {
    // N0: a required observation the Attempt does not hold, or an expired fence, fails before anything is written.
    if (input.observationRequired && !input.observation || expired()) throw new Error('unverified');
    const lines = sealWorkerEventLog(input.events, input.verification, input.unreported, input.maxBytes, input.observation);
    if (!lines.length) return Object.freeze({ status: 'nothing-to-seal' });
    const bytes = Buffer.from(lines.join('')), receipt = await fenced(artifacts.put(identity.scopeId, bytes), input.deadline);
    // The stored bytes must read back equal; the fence ends where the ledger write starts, so its result alone decides and never contradicts the row.
    if (input.observation && !await readsBack(artifacts, identity, receipt, bytes, input.deadline) || expired()) throw new Error('unverified');
    await store.saveWorkerEventLog({ schemaVersion: 1, identity, events: receipt, eventCount: lines.length, sealedAt: Date.now(),
      projection: input.projectionComplete === false ? 'partial' : 'complete' });
    return Object.freeze({ status: 'sealed', eventCount: lines.length });
  } catch (error) {
    // The live sidecar remains; the failure never changes the execution outcome but is returned typed (never silent).
    return Object.freeze({ status: 'failed', code: 'WORKER_EVENTS_SEAL_FAILED', cause: causeOf(error) });
  }
}

type SealSource = Readonly<{ modelVerification(): SealInput['verification'] | undefined; statistics(): Readonly<{ eventsUnreported: number }> }>;
/** N0 close owner: drain the live sink, then seal. Only an offered observation bounds both by `deadlineMs`, the existing control timeout (held implies offered).
 * `null`: the expected sink failed to open (projection partial). Without an offered observation it is HEAD's sequence: a sink or source fault rejects as before.
 * With one, the sink drains before the held row is read and every fault maps to the existing failure (`cause: null`), never thrown over the task. */
export async function closeAndSealAttemptWorkerEvents(identity: AttemptIdentity, artifacts: Artifacts, store: Pick<SqliteAttemptStore, 'saveWorkerEventLog'>,
  sink: Pick<Awaited<ReturnType<typeof openWorkerEventSink>>, 'close'> | null | undefined, input: Readonly<{ source?: SealSource | undefined;
    held?: (() => SealInput['observation']) | undefined; offered?: boolean | undefined; maxBytes: number; deadlineMs: number }>): Promise<WorkerEventSealing> {
  const seal = (closed: Awaited<ReturnType<NonNullable<typeof sink>['close']>> | undefined, offered?: Pick<SealInput, 'observation' | 'deadline'>) =>
    sealAttemptWorkerEvents(identity, artifacts, store, { events: closed?.events ?? [], verification: input.source?.modelVerification() ?? null,
      unreported: input.source?.statistics().eventsUnreported ?? 0, projectionComplete: sink === null ? false : closed?.projectionComplete, maxBytes: input.maxBytes,
      ...(offered ? { ...offered, observationRequired: true } : {}) });
  if (!input.offered) return seal(await sink?.close());
  const deadline = performance.now() + input.deadlineMs;
  const drained = await Promise.resolve().then(() => sink?.close(input.deadlineMs)).then(closed => ({ closed }), () => null);
  let sealing: WorkerEventSealing;
  try {
    if (!drained) throw new Error('unverified');
    sealing = await seal(drained.closed, { observation: input.held?.(), deadline });
  } catch { sealing = Object.freeze({ status: 'failed', code: 'WORKER_EVENTS_SEAL_FAILED', cause: null }); }
  // Owner D4: the close owner records that this Attempt's log could not be verified; only a successful insert makes that durable. The store keeps
  // the first row of either shape (a sealed log is never replaced): its refusal (WORKER_OBSERVATION_INVALID, a first row exists) is expected and
  // silent. N0 R5: any other write failure is named in the returned failure's `cause`, the existing diagnostic path; nothing new is stored or refused.
  if (sealing.status !== 'failed') return sealing;
  try { await store.saveWorkerEventLog({ schemaVersion: 1, identity, sealedAt: Date.now(), outcome: 'unverified' }); return sealing; }
  catch (error) { return causeOf(error) === 'WORKER_OBSERVATION_INVALID' ? sealing : Object.freeze({ ...sealing, cause: causeOf(error) }); }
}
