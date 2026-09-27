import { readWorkerFinalReport, attemptIdentitySchema, summarizeWorkerEvents, workerActivityPhase, workerEventSchema, type AttemptIdentity, type VerifiedPrincipal } from '#domain/index.js';
import type { ArtifactReceipt } from '#capabilities/index.js';
import { parseRetainedOutputEnvelope, type RunBoundDispatchStore, type DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { WorkerObservationError, type WorkerEventLogStore } from './contract.js';
export interface WorkerEventArtifacts { read(scopeId: string, receipt: ArtifactReceipt): Promise<Uint8Array> }
/** Sealed, redacted worker-reported events of one attempt with a deterministic summary and last activity. Evidence for interpretation:
 * the dispatch terminal record, patch and Task evaluation remain the authority for outcome and acceptance. */
export class WorkerTranscriptApplication {
  constructor(private readonly store: Pick<WorkerEventLogStore, 'loadWorkerEventLog'> & RunBoundDispatchStore, private readonly artifacts: WorkerEventArtifacts,
    private readonly authorization: DispatchIdentityAuthorization) {}
  async inspect(input: AttemptIdentity, principal: VerifiedPrincipal) {
    const identity = attemptIdentitySchema.parse(input);
    await this.authorization.authorizeIdentity('read-output', identity, principal);
    const log = await this.store.loadWorkerEventLog(identity.scopeId, identity.attemptId);
    let finalReport = readWorkerFinalReport('');
    try {
      const dispatch = await this.store.loadBoundDispatch(identity);
      if (dispatch?.output) finalReport = readWorkerFinalReport(parseRetainedOutputEnvelope(
        await this.artifacts.read(identity.scopeId, dispatch.output), identity).stdout);
    } catch { finalReport = { schemaVersion: 1, kind: 'native-worker-report', status: 'unavailable', reason: 'invalid' }; }
    // An unavailable output does not hide a separately sealed event log; it cannot produce a report claim.
    if (!log) return Object.freeze({ schemaVersion: 2 as const, identity, finalReport, sealed: null, summary: null, activity: null, events: Object.freeze([]) });
    if (JSON.stringify(log.identity) !== JSON.stringify(identity)) throw new WorkerObservationError('WORKER_OBSERVATION_INVALID');
    let events;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await this.artifacts.read(identity.scopeId, log.events));
      events = text.split('\n').filter(Boolean).map(line => workerEventSchema.parse(JSON.parse(line)));
    } catch { throw new WorkerObservationError('WORKER_OBSERVATION_INVALID'); }
    return Object.freeze({ schemaVersion: 2 as const, identity, finalReport, sealed: Object.freeze({ eventCount: log.eventCount, sealedAt: log.sealedAt, projection: log.projection ?? 'complete' }),
      summary: summarizeWorkerEvents(events), activity: workerActivityPhase(events), events: Object.freeze(events) });
  }
}
